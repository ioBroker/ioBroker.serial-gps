'use strict';

const setup = require('@iobroker/legacy-testing');
const { readFileSync } = require('node:fs');
const { createSocket } = require('node:dgram');

let objects = null;
let states = null;

function checkConnection(done, counter) {
    counter ||= 0;
    if (counter > 20) {
        done?.('Cannot check connection after 20 attempts');
        return;
    }

    states.getState('serial-gps.0.info.connection', (err, state) => {
        if (err) {
            console.error(err);
        }
        if (state?.val) {
            done();
        } else {
            setTimeout(() => checkConnection(done, counter + 1), 1000);
        }
    });
}

let interval = null;

function sendDataToImitateConnection() {
    interval ||= setInterval(() => {
        const sock = createSocket('udp4');
        const buf = Buffer.from('GNGGA,191721.000,4331.6629,N,01557.8394,E,2,18,0.70,-4.7,M,40.9,M,,*5F', 'utf8');

        sock.send(buf, 0, buf.length, 50547, '127.0.0.1', (err) => {
            sock.close();
            if (err) {
                console.log('Cannot send data to imitate connection', err);
            }
        });

        sock.on('error', (err) => {
            sock.close();
            console.log('Cannot send data to imitate connection', err);
        });
    }, 1000);
}

describe.only('serial-gps: Test parser', () => {
    before('serial-gps: Start js-controller', function (_done) {
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

    it('serial-gps: Check if connected', done => {
        sendDataToImitateConnection();
        checkConnection(() => {
            clearInterval(interval);
            interval = null;
            done();
        });
    }).timeout(10000);

    it('serial-gps: It must see position and other values', async () => {
        const data = readFileSync(`${__dirname}/data.txt`).toString().split('\n');
        const sock = createSocket('udp4');
        for (const line of data) {
            await new Promise((resolve, reject) => {
                const buf = Buffer.from(`${line}\n`, 'ascii');

                sock.send(buf, 0, buf.length, 50547, '127.0.0.1', err => err ? reject(err) : resolve());

                sock.on('error', (err) => reject(err));
            });
        }
        sock.close();
        // check the values
        let state = await new Promise(resolve => states.getState('serial-gps.0.gps.latitude', (_err, state) => resolve(state)));
        if (state.val !== 43.527715) {
            throw new Error(`State info.connection expected to be true but found ${state.val}`);
        }
        state = await new Promise(resolve => states.getState('serial-gps.0.gps.longitude', (_err, state) => resolve(state)));
        if (state.val !== 15.96399) {
            throw new Error(`State info.connection expected to be true but found ${state.val}`);
        }
    }).timeout(5000);


    after('serial-gps Server: Stop js-controller', function (_done) {
        // let FUNCTION and not => here
        this.timeout(5000);
        setup.stopController(() => _done());
    });
});
