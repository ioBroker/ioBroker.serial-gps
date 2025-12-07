/* jshint -W097 */
/* jshint strict: true */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const setup = require('@iobroker/legacy-testing');
const { readFileSync } = require('node:fs');
import * as dgram from 'node:dgram';

let objects = null;
let states = null;
let mqttClientEmitter = null;
let connected = false;

function checkConnection(value, done, counter) {
    counter ||= 0;
    if (counter > 20) {
        done?.(`Cannot check ${value}`);
        return;
    }

    states.getState('serial-gps.0.info.connection', (err, state) => {
        if (err) {
            console.error(err);
        }
        if (
            typeof state?.val === 'string' &&
            ((!value && state.val === '') || (value && state.val.split(',').includes(value)))
        ) {
            connected = value;
            done();
        } else {
            setTimeout(() => checkConnection(value, done, counter + 1), 1000);
        }
    });
}

export function sendUdpString(message, host = '127.0.0.1', port = 50547) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        const buf = Buffer.from(message, 'utf8');

        sock.send(buf, 0, buf.length, port, host, (err) => {
            sock.close();
            if (err) {
                return reject(err);
            }
            resolve();
        });

        sock.on('error', (err) => {
            sock.close();
            reject(err);
        });
    });
}


describe('serial-gps server: Test parser', () => {
    before('serial-gps server: Start js-controller', function (_done) {
        //
        this.timeout(600000); // because of the first installation from npm
        setup.adapterStarted = false;

        setup.setupController(async () => {
            const config = await setup.getAdapterConfig();
            // enable adapter
            config.common.enabled = true;
            config.common.loglevel = 'debug';

            await setup.setAdapterConfig(config.common, config.native);

            setup.startController((_objects, _states) => {
                objects = _objects;
                states = _states;
                _done();
            });
        });
    });

    it('serial-gps Server: Check if connected to MQTT broker', done => {
        if (!connected) {
            checkConnection(true, done);
        } else {
            done();
        }
    }).timeout(2000);

    it('serial-gps Server: It must see position and other values', async () => {
        const data = readFileSync(`${__dirname}/data.txt`).toString().split('\n');
        const sock = dgram.createSocket('udp4');
        for (const line of data) {
            await new Promise((resolve, reject) => {
                const buf = Buffer.from(line, 'utf8');

                sock.send(buf, 0, buf.length, 50547, '127.0.0.1', (err) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });

                sock.on('error', (err) => {

                    reject(err);
                });
            });
        }
        sock.close();
        // check the values
        let state = new Promise(resolve => states.getState('serial-gps.0.info.connection', (_err, state) => resolve(state)));
        if (state.val !== true) {
            throw new Error(`State info.connection expected to be true but found ${state.val}`);
        }
    }).timeout(5000);


    after('serial-gps Server: Stop js-controller', function (_done) {
        // let FUNCTION and not => here
        this.timeout(5000);
        setup.stopController(() => _done());
    });
});
