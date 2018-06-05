/**
 * @typedef ServerlessConfig
 * @type {object}
 * @property {string} service Name of the service
 * @property {string[]} plugins
 * @property {object} provider
 * @property {object} custom
 * @property {object} package
 * @property {Object.<string, ServerlessFunction>} functions
 * @property {object} resources
 * 
 * @typedef ServerlessFunction
 * @type {object}
 * @property {string} handler Function called by the invoke
 * @property {string} description Plain-text description of the function
 * @property {string} role The IAM role to use when invoking
 * @property {object} environment
 */

const path = require('path');
const express = require('express');
const app = express();
const ymlParser = require('require-yml');
const pino = require('pino');
const prettyLogs = pino.pretty({forceColor: true, messageKey: 'msg'});
prettyLogs.pipe(process.stdout);
const logger = pino({name: 'app'}, prettyLogs);

/** @type {ServerlessConfig} */
const slsConfig = ymlParser(path.resolve(process.cwd(), 'serverless.yml'));

app.use(express.json({type: ['application/json','binary/octet-stream']}));
/**
 * Unfortunately the CLI SDK doesn't send a Content-Type in the request, try to parse it manually
 */
app.use((req, res, next) => {
    if ( !req.get('Content-Type') || !req.body || Object.entries(req.body).length < 1 ) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            if ( body.charAt(0) === '{' ) {
                try {
                    body = JSON.parse(body);
                } catch(err) {
                    return next(err);
                }
            req.body = body;
            next();
        });
        req.resume();
    }
});

// We need to setup a pattern that serves requests like below into a serverless function
// POST /2015-03-31/functions/createKey/invocations 403 1.456 ms - 23
process.env.IS_LOCAL = true;
process.env.NODE_ENV = process.env.NODE_ENV || slsConfig.provider.stage || 'dev';

const {service: serviceName, functions: functionDefs} = slsConfig;
let functionCount = 0;

Object.entries(functionDefs).forEach(([functionName, functionDef]) => {
    const handlerDef = functionDef.handler.split('.');
    const logger = pino({name: `Function:${functionName}`}, prettyLogs);
    let handler;

    try {
        const handlerModule = require(path.resolve(process.cwd(), handlerDef[0]));
        handler = handlerModule[handlerDef[1]];
        if ( typeof handler !== 'function' ) throw new Error(`${functionDef} is not a function`);
    } catch(err) {
        logger.error({msg: `Could not setup function ${functionName}: ${err.toString()}`});
        return;
    }

    logger.info({msg: `Discovered function ${functionName} with handler ${functionDef.handler}`});
    app.post(`/2015-03-31/functions/${functionName}/invocations`, (req, res) => {
        const {body} = req;
        let isPromise = false;
        let invocation;

        const errHandler = (err) => {
            logger.error({msg: `Error invoking ${functionName}`, params: body, error: err});
            res.status(500).send();
        };
        const successHandler = (response) => {
            logger.info({msg: `Successfully invoked ${functionName}`, params: body, response});
            res.status(200).send(response);
        }

        try {
            const startAt = Date.now();
            const endAt = startAt + ((slsConfig.provider.timeout || 6) * 1000);
            logger.info({msg: `Invoking ${functionName}`, params: body});
            invocation = handler(body, {getRemainingTimeInMillis: () => endAt - Date.now()}, (result) => !isPromise && successHandler(result));
        } catch(err) {
            return errHandler(err);
        }

        if ( invocation instanceof Promise ) {
            isPromise = true;
            invocation.then(successHandler).catch(errHandler);
        }
    });
    functionCount++;
});

const listener = app.listen(5050, () => {
    const address = listener.address();
    const host = address.address == '::' ? 'localhost' : address.address;
    logger.info({msg: `Listening with ${functionCount} available functions. Please point your AWS SDK endpoint to http://${host}:${address.port}`});
});