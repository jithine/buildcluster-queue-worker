'use strict';

const amqp = require('amqp-connection-manager');
const threads = require('threads');
const logger = require('screwdriver-logger');
const helper = require('./lib/helper');
const config = require('./lib/config');
const retryQueueLib = require('./lib/retry-queue');
const {
    amqpURI,
    host,
    connectOptions,
    queue,
    prefetchCount,
    messageReprocessLimit,
    cacheStrategy,
    cachePath,
    retryQueue
} = config.getConfig();
const { spawn } = threads;
const CACHE_STRATEGY_DISK = 'disk';
let channelWrapper;

/**
 * onMessage consume messages in batches, once its available in the queue. channelWrapper has in-built back pressure
 *            meaning if consumed messages are not ack'd or nack'd, it will not fetch more messages. Definitely need
 *            to ack or nack messages, otherwise it will halt indefinitely. submit start or stop jobs to build executor
 *            using threads.
 *            job = 'start' (or) 'stop' => message is to start or stop build.
 *            job = 'clear' => message is to clear pipeline or job cache directory.
 *              clear cache message should be in below json format:
 *                  {"job":"clear","cacheConfig":{"resource":"caches","action":"delete","scope":"pipelines","prefix":"","pipelineId": 1,id":1}}
 *                  scope => "pipelines" (or) jobs; id => based on scope, either pipeline id (or) job id
 * @param  {Object} data  Message from queue with headers, timestamp, and other properties; will be used to ack or nack the message
 */
const onMessage = data => {
    try {
        const fullBuildConfig = JSON.parse(data.content);
        const jobType = fullBuildConfig.job;
        const buildConfig = fullBuildConfig.buildConfig || fullBuildConfig.cacheConfig;

        if (jobType === 'clear') {
            const threadCache = spawn('./lib/cache.js');
            const job = `jobType: ${jobType}, cacheConfig: ${buildConfig}`;

            logger.info(`processing ${job}`);

            if (
                cacheStrategy === CACHE_STRATEGY_DISK &&
                cachePath !== '' &&
                buildConfig.resource === 'caches' &&
                buildConfig.action === 'delete' &&
                buildConfig.scope !== '' &&
                buildConfig.pipelineId !== '' &&
                buildConfig.id !== ''
            ) {
                // eslint-disable-next-line max-len
                let dir2Clean = buildConfig.prefix !== '' ? `${cachePath}/${buildConfig.prefix}` : `${cachePath}`;

                dir2Clean = `${dir2Clean}/${buildConfig.scope}/${buildConfig.pipelineId}`;

                if (buildConfig.scope !== 'pipelines') {
                    dir2Clean = `${dir2Clean}/${buildConfig.id}`;
                }

                logger.info(`cache directory to clean: ${dir2Clean}`);
                threadCache
                    .send([dir2Clean])
                    .on('message', () => {
                        logger.info(`acknowledge, clear cache job completed for ${dir2Clean}`);
                        channelWrapper.ack(data);
                        threadCache.kill();
                    })
                    .on('error', error => {
                        logger.info(`acknowledge, clear cache job for ${dir2Clean} - error: ${error} `);
                        channelWrapper.ack(data);
                        threadCache.kill();
                    })
                    .on('exit', () => {
                        logger.info(`thread terminated for clear cache job ${dir2Clean}`);
                    });
            } else {
                logger.error(
                    `required conditions not met, cacheStrategy: ${cacheStrategy}, ` +
                        `cachePath: ${cachePath}, cacheConfig: ${buildConfig}, ` +
                        `acknowledge data: ${data}, payload: ${data.content} `
                );
                channelWrapper.ack(data);
            }
        } else {
            const thread = spawn('./lib/jobs.js');
            let retryCount = 0;
            const { buildId } = buildConfig;
            const job = `jobId: ${buildConfig.jobId}, jobType: ${jobType}, buildId: ${buildId}`;

            logger.info(`processing ${job}`);

            if (typeof data.properties.headers !== 'undefined') {
                if (Object.keys(data.properties.headers).length > 0) {
                    retryCount = data.properties.headers['x-death'][0].count;
                    logger.info(`retrying ${retryCount}(${messageReprocessLimit}) for ${job}`);
                }
            }

            thread
                .send([jobType, buildConfig, job])
                .on('message', successful => {
                    logger.info(`acknowledge, job completed for ${job}, result: ${successful}`);
                    if (!successful && jobType === 'start') {
                        // push to retry only for start jobs
                        retryQueueLib.push(buildConfig, buildId);
                    }
                    channelWrapper.ack(data);
                    thread.kill();
                })
                .on('error', error => {
                    if (retryCount >= messageReprocessLimit) {
                        logger.info(`acknowledge, max retries exceeded for ${job}`);
                        helper.updateBuildStatus(buildConfig, 'FAILURE', `${error}`, (err, response) => {
                            if (err) {
                                // eslint-disable-next-line max-len
                                logger.error(
                                    `failed to update build status for build ${buildId}: ${err} ${JSON.stringify(
                                        response
                                    )}`
                                );
                            } else {
                                // eslint-disable-next-line max-len
                                logger.info(`build status successfully updated for build ${buildId}`);
                            }
                        });
                        channelWrapper.ack(data);
                    } else {
                        logger.info(
                            `err: ${error}, don't acknowledge, ` +
                                `retried ${retryCount}(${messageReprocessLimit}) for ${job}`
                        );
                        channelWrapper.nack(data, false, false);
                    }
                    thread.kill();
                })
                .on('exit', () => {
                    logger.info(`thread terminated for ${job} `);
                });
        }
    } catch (err) {
        logger.error(`error ${err}, acknowledge data: ${data} payload: ${data.content} `);
        channelWrapper.ack(data);
    }
};

/**
 * onMessage consume messages in batches, once its available in the queue. channelWrapper has in-built back pressure
 *            meaning if consumed messages are not ack'd or nack'd, it will not fetch more messages. Definitely need
 *            to ack or nack messages, otherwise it will halt indefinitely. submit start or stop jobs to build executor
 *            using threads.
 *            job = 'verify' => message is to verify the build.
 * @param  {Object} data  Message from queue with headers, timestamp, and other properties; will be used to ack or nack the message
 */
const onRetryMessage = async data => {
    try {
        const parsedData = JSON.parse(data.content);
        const { job: jobType, buildConfig } = parsedData;
        const thread = spawn('./lib/jobs.js');
        let retryCount = 0;
        const { buildId } = buildConfig;
        const job = `jobId: ${buildConfig.jobId}, jobType: ${jobType}, buildId: ${buildId}`;

        logger.info(`processing ${job}`);

        if (typeof data.properties.headers !== 'undefined') {
            if (Object.keys(data.properties.headers).length > 0) {
                retryCount = data.properties.headers['x-death'][0].count;
                logger.info(`retrying ${retryCount}(${messageReprocessLimit}) for ${job}`);
            }
        }
        thread
            .send([jobType, buildConfig, job])
            .on('message', async message => {
                logger.info(`acknowledge, job completed for ${job}, result: ${message}`);
                if (message) {
                    try {
                        await helper.updateBuildStatusAsync(buildConfig, 'FAILURE', message);
                        logger.info(`build status successfully updated for build ${buildId}`);
                    } catch (err) {
                        logger.error(`Failed to update build statusto FAILURE for build:${buildId}:${err}`);
                    }
                }
                channelWrapper.ack(data);
                thread.kill();
            })
            .on('error', async error => {
                if (retryCount >= messageReprocessLimit) {
                    logger.info(`acknowledge, max retries exceeded for ${job} ${error}`);
                    try {
                        await helper.updateBuildStatusAsync(buildConfig, 'FAILURE', error.message);
                        logger.info(`build status successfully updated for build ${buildId}`);
                    } catch (err) {
                        logger.error(`Failed to update build statusto FAILURE for build:${buildId}:${err}`);
                    }
                    channelWrapper.ack(data);
                } else {
                    logger.info(
                        `err: ${error}, don't acknowledge, retried ` +
                            `${retryCount}(${messageReprocessLimit}) for ${job}`
                    );
                    channelWrapper.nack(data, false, false);
                }
                thread.kill();
            })
            .on('exit', () => {
                logger.info(`thread terminated for ${job} `);
            });
    } catch (err) {
        logger.error(`${retryQueue}: error ${err}, acknowledge data: ${data} payload: ${data.content} `);
        channelWrapper.ack(data);
    }
};

/**
 * Invoke function to start listening for messages
 * @returns {Object} Returns the connection obj
 */
const listen = async () => {
    const connection = amqp.connect([amqpURI], connectOptions);

    connection.on('connect', () => {
        logger.info('rabbitmq server connected!');
    });

    connection.on('disconnect', params => {
        logger.info(`server disconnected: ${params.err.stack}. reconnecting rabbitmq server ${host}`);
    });

    const setup = channel =>
        Promise.all([
            channel.checkQueue(queue),
            channel.prefetch(prefetchCount),
            channel.consume(queue, onMessage),
            channel.checkQueue(retryQueue),
            channel.consume(retryQueue, onRetryMessage)
        ]);

    channelWrapper = connection.createChannel({
        setup
    });

    channelWrapper.waitForConnect().then(() => {
        logger.info(`waiting for messages in queues: ${queue} | ${retryQueue}`);
    });

    return connection;
};

module.exports.listen = listen;
