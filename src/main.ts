import { type Socket, createSocket } from 'node:dgram';
import { SerialPort } from 'serialport';
import { Adapter, type AdapterOptions } from '@iobroker/adapter-core'; // Get common adapter utils
import type { SerialGpsAdapterConfig } from './types';

function verifyChecksum(sentence: string): boolean {
    const asterisk = sentence.indexOf('*');
    if (asterisk === -1) {
        return true;
    } // no checksum present -> accept
    const payload = sentence.substring(0, asterisk);
    const chkStr = sentence.substring(asterisk + 1).trim();
    let chk = 0;
    for (let i = 0; i < payload.length; i++) {
        chk ^= payload.charCodeAt(i);
    }
    const hex = chk.toString(16).toUpperCase().padStart(2, '0');
    return hex === chkStr.toUpperCase();
}

function nmeaToDecimal(coord: string, hemi: string): number | null {
    if (!coord) {
        return null;
    }

    const dot = coord.indexOf('.');
    if (dot === -1) {
        return null;
    } // kein Dezimalpunkt -> ungültig

    // für N/S sind die Grad 2 Stellen, für E/W 3 Stellen
    const degLen = hemi === 'N' || hemi === 'S' ? 2 : 3;

    if (coord.length <= degLen) {
        return null;
    } // nicht genug Zeichen

    const degStr = coord.substring(0, degLen);
    const minStr = coord.substring(degLen); // enthält Minuten + Dezimalteil

    const deg = parseInt(degStr, 10);
    const min = parseFloat(minStr);

    if (isNaN(deg) || isNaN(min)) {
        return null;
    }

    let val = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') {
        val = -val;
    }
    return val;
}

function parseNmeaDateTime(timeStr?: string, dateStr?: string): number | null {
    if (!timeStr) {
        return null;
    }
    // timeStr: hhmmss[.sss], dateStr: ddmmyy
    const hh = parseInt(timeStr.slice(0, 2) || '0', 10);
    const mm = parseInt(timeStr.slice(2, 4) || '0', 10);
    const secFloat = parseFloat(timeStr.slice(4) || '0');
    const ss = Math.floor(secFloat);
    const ms = Math.round((secFloat - ss) * 1000);

    let year = 1970,
        month = 0,
        day = 1;
    if (dateStr && dateStr.length >= 6) {
        day = parseInt(dateStr.slice(0, 2) || '1', 10);
        month = parseInt(dateStr.slice(2, 4) || '1', 10) - 1;
        const yy = parseInt(dateStr.slice(4, 6) || '0', 10);
        year = yy >= 70 ? 1900 + yy : 2000 + yy;
    } else {
        // Kein Datum verfügbar -> verwende heutiges Datum in UTC (nur Uhrzeit sinnvoll)
        const now = new Date();
        year = now.getUTCFullYear();
        month = now.getUTCMonth();
        day = now.getUTCDate();
    }

    return Date.UTC(year, month, day, hh, mm, ss, ms);
}

export class SerialGpsAdapter extends Adapter {
    declare config: SerialGpsAdapterConfig;
    private serialPort?: SerialPort;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private lastStates = new Map<string, { val: any; ts: number }>();
    private recvBuffer = '';
    private lastDate = ''; // ddmmyy aus letztem RMC, für GGA Zeitkombination
    private udpServer?: Socket;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'serial-gps',
            unload: async callback => {
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                await this.closeUdpServer();
                await this.closePort();
                callback();
            },
            message: async obj => {
                // read all serial ports and give them back to GUI
                if (obj) {
                    switch (obj.command) {
                        case 'list':
                            if (obj.callback) {
                                try {
                                    // read all found serial ports
                                    const ports = await SerialPort.list();
                                    this.log.info(`List of port: ${JSON.stringify(ports)}`);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        ports.map(item => ({
                                            label: item.path,
                                            value: item.path,
                                        })),
                                        obj.callback,
                                    );
                                } catch (e) {
                                    this.log.error(`Cannot list ports: ${e}`);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        [{ label: 'Not available', value: '' }],
                                        obj.callback,
                                    );
                                }
                            }

                            break;

                        case 'detectBaudRate':
                            if (obj.callback) {
                                try {
                                    const baudRate = await this.detectBaudRate(obj.message.serialPort);
                                    if (baudRate) {
                                        this.sendTo(obj.from, obj.command, { native: { baudRate } }, obj.callback);
                                    } else {
                                        this.sendTo(
                                            obj.from,
                                            obj.command,
                                            { error: 'Cannot detect baud rate' },
                                            obj.callback,
                                        );
                                    }
                                } catch {
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        [{ label: 'Not available', value: '' }],
                                        obj.callback,
                                    );
                                }
                            }

                            break;

                        case 'test':
                            if (obj.callback) {
                                try {
                                    const result = await this.test(obj.message.serialPort, obj.message.baudRate);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        {
                                            result: result ? 'GPS Receiver detected' : 'GPS Receiver not detected',
                                            error: !result ? 'GPS Receiver not detected' : undefined,
                                        },
                                        obj.callback,
                                    );
                                } catch (e) {
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        { error: `Test failed: ${e.message || e}` },
                                        obj.callback,
                                    );
                                }
                            }
                            break;
                    }
                }
            },
            ready: () => this.main(),
        });
    }

    private async test(port: string, baudRate: string | number): Promise<boolean> {
        let portClosed = false;
        if (this.config.serialPort === port) {
            portClosed = true;
            await this.closePort();
        }
        const result = await this.testPort(port, baudRate);
        if (portClosed) {
            await this.openPort();
        }
        return result;
    }

    private async testPort(port: string, baudRate: number | string): Promise<boolean> {
        this.log.info(`Testing port ${port} with baud rate ${baudRate}`);
        const testPort = new SerialPort({
            path: port,
            baudRate: parseInt(baudRate as string, 10),
            autoOpen: false,
        });
        await new Promise<void>((resolve, reject) => {
            testPort.open(err => {
                if (err) {
                    this.log.error(`Failed to open serial port ${port} at ${baudRate}: ${err.message || err}`);
                    reject(err);
                    return;
                }
                this.log.info(`Serial port opened for testing: ${port} @ ${baudRate}`);
                resolve();
            });
        });

        let receivedData = false;
        let receiveBuffer = '';
        const dataListener = (data: Buffer): void => {
            receiveBuffer += data.toString('utf8');
            this.log.info(`Received data at baud rate ${baudRate}: ${receiveBuffer}`);
            // try to detect specific NMEA sentence starts
            if (
                receiveBuffer.includes('$GPGGA') ||
                receiveBuffer.includes('$GPRMC') ||
                receiveBuffer.includes('$GNGGA') ||
                receiveBuffer.includes('$GNRMC')
            ) {
                receivedData = true;
            }
        };
        testPort.on('data', dataListener);

        // Wait up to 2 seconds for data
        await new Promise<void>(resolve => setTimeout(() => resolve(), 2000));

        testPort.off('data', dataListener);
        await new Promise<void>(resolve => {
            testPort.close(err => {
                if (err) {
                    this.log.error(`Error closing test port: ${err.message || err}`);
                }
                this.log.info(`Test serial port closed: ${port} @ ${baudRate}`);
                resolve();
            });
        });

        if (receivedData) {
            this.log.info(`Detected baud rate: ${baudRate}`);
            return true;
        }
        return false;
    }

    private async detectBaudRate(port: string): Promise<number> {
        let portClosed = false;
        if (this.config.serialPort === port) {
            portClosed = true;
            await this.closePort();
        }
        const baudRatesToTest = [4800, 9600, 19200, 38400, 57600, 115200];
        for (const baudRate of baudRatesToTest) {
            this.log.info(`Testing baud rate: ${baudRate}`);
            if (await this.testPort(port, baudRate)) {
                if (portClosed) {
                    await this.openPort();
                }
                return baudRate;
            }
        }
        this.log.warn(`Could not detect baud rate for port: ${port}`);
        if (portClosed) {
            await this.openPort();
        }
        return 0;
    }

    private closePort(): Promise<void> {
        if (this.serialPort) {
            return new Promise(resolve => {
                try {
                    if (this.serialPort!.isOpen) {
                        this.serialPort!.close(err => {
                            if (err) {
                                this.log.error(`Error closing serial port: ${err.message || err}`);
                            }
                            this.log.info('Serial port closed');
                            resolve();
                        });
                        return;
                    }
                } catch (e) {
                    this.log.warn(`Error while closing port: ${(e as Error).message || e}`);
                }
                this.serialPort = undefined;
                resolve();
            });
        }
        return Promise.resolve();
    }

    private async setStateIfChangedAsync(id: string, value: ioBroker.StateValue): Promise<void> {
        const now = Date.now();
        const prev = this.lastStates.get(id);
        const changed = !prev || value !== prev.val;
        if (!changed && prev && now - prev.ts < 60000) {
            // unchanged and not older than 60s -> skip
            return;
        }
        this.lastStates.set(id, { val: value, ts: now });
        await this.setStateAsync(id, value, true);
    }

    private async parseData(text: string): Promise<void> {
        // Split by '$' because some devices send multiple sentences in one chunk (sentences start with $)
        const parts = text
            .split('$')
            .map(p => p.trim())
            .filter(p => p.length > 0);

        for (const raw of parts) {
            const sentence = raw.startsWith('$') ? raw : `$${raw}`;
            // remove any trailing characters beyond checksum
            const s = sentence.replace(/\r?\n/g, '').trim();
            if (!s.startsWith('$')) {
                continue;
            }
            const body = s.slice(1); // without leading $
            if (!verifyChecksum(body)) {
                this.log.warn(`NMEA checksum mismatch: ${s}`);
                continue;
            }

            if (this.common?.loglevel === 'debug') {
                console.log(body);
            } else {
                this.log.silly(body);
            }

            const asteriskIdx = body.indexOf('*');
            const payload = asteriskIdx >= 0 ? body.substring(0, asteriskIdx) : body;
            const fields = payload.split(',');
            const type = fields[0];

            try {
                if (type.endsWith('GGA')) {
                    // $--GGA,time,lat,NS,lon,EW,fix,numSat,hdop,alt,altUnit,...
                    const timeStr = fields[1];
                    const lat = nmeaToDecimal(fields[2], fields[3]);
                    const lon = nmeaToDecimal(fields[4], fields[5]);
                    const fix = parseInt(fields[6], 10) || 0;
                    const sats = parseInt(fields[7], 10) || 0;
                    const hdop = parseFloat(fields[8]) || 0;
                    const alt = parseFloat(fields[9]) || 0;
                    if (timeStr) {
                        const ts = parseNmeaDateTime(timeStr, this.lastDate || undefined);
                        if (ts !== null) {
                            await this.setStateIfChangedAsync('gps.timestamp', ts);
                        }
                    }
                    if (!isNaN(fix)) {
                        await this.setStateIfChangedAsync('gps.fix_quality', fix);
                    }
                    if (lat !== null && lon !== null) {
                        await this.setStateIfChangedAsync('gps.latitude', lat);
                        await this.setStateIfChangedAsync('gps.longitude', lon);
                        await this.setStateIfChangedAsync('gps.position', `${lon};${lat}`);
                        await this.setStateIfChangedAsync('gps.latlon', `${lat};${lon}`);
                        this.log.debug(`GGA parsed: lat=${lat}, lon=${lon}`);
                    }
                    await this.setStateIfChangedAsync('gps.satellites', sats);
                    await this.setStateIfChangedAsync('gps.hdop', hdop);
                    await this.setStateIfChangedAsync('gps.altitude', alt);

                    const connected = fix > 0;
                    await this.setStateIfChangedAsync('info.connection', connected);
                } else if (type.endsWith('RMC')) {
                    // $--RMC,time,status,lat,NS,lon,EW,sog,cog,date,...
                    const timeStr = fields[1];
                    const status = fields[2]; // A=active, V=void
                    const lat = nmeaToDecimal(fields[3], fields[4]);
                    const lon = nmeaToDecimal(fields[5], fields[6]);
                    const speedKnots = parseFloat(fields[7]) || 0;
                    const course = parseFloat(fields[8]) || 0;
                    const dateStr = fields[9]; // ddmmyy

                    // speichere Datum für spätere GGA-Zeiten
                    if (dateStr) {
                        this.lastDate = dateStr;
                        await this.setStateIfChangedAsync('gps.date', dateStr);
                    }
                    // timestamp (Zeit + Datum)
                    const ts = parseNmeaDateTime(timeStr, dateStr);
                    if (ts !== null) {
                        await this.setStateIfChangedAsync('gps.timestamp', ts);
                    }
                    if (lat !== null && lon !== null) {
                        await this.setStateIfChangedAsync('gps.latitude', lat);
                        await this.setStateIfChangedAsync('gps.longitude', lon);
                        await this.setStateIfChangedAsync('gps.position', `${lon};${lat}`);
                        await this.setStateIfChangedAsync('gps.latlon', `${lat};${lon}`);
                        this.log.debug(`RMC parsed: lat=${lat}, lon=${lon}`);
                    }
                    // convert knots to km/h
                    const speedKmh = +(speedKnots * 1.852).toFixed(2);
                    await this.setStateIfChangedAsync('gps.speed_knots', speedKnots);
                    await this.setStateIfChangedAsync('gps.speed_kmh', speedKmh);
                    await this.setStateIfChangedAsync('gps.course', course);

                    const connected = status === 'A';
                    await this.setStateIfChangedAsync('info.connection', connected);
                } else if (type.endsWith('GSA')) {
                    // $--GSA,mode,fixType,SV1,...,SV12,pdop,hdop,vdop
                    const fixMode = fields[2] || '';
                    const pdop = parseFloat(fields[15]) || 0;
                    const hdop = parseFloat(fields[16]) || 0;
                    const vdop = parseFloat(fields[17]) || 0;

                    // fix_mode: '2' -> "2D", '3' -> "3D", sonst original
                    const fixModeLabel = fixMode === '2' ? '2D' : fixMode === '3' ? '3D' : fixMode;

                    await this.setStateIfChangedAsync('gps.fix_mode', fixModeLabel);
                    await this.setStateIfChangedAsync('gps.pdop', pdop);
                    // hdop wird ggf. bereits durch GGA gesetzt; trotzdem aktualisieren ist ok
                    await this.setStateIfChangedAsync('gps.hdop', hdop);
                    await this.setStateIfChangedAsync('gps.vdop', vdop);
                } else {
                    // other sentence types can be handled if needed
                    this.log.silly(`Unhandled NMEA sentence: ${type}`);
                }
            } catch (e) {
                this.log.error(`Error parsing NMEA sentence ${s}: ${(e as Error).message}`);
            }
        }
    }

    private async processReceivedData(data: Buffer): Promise<void> {
        const chunk = data.toString('utf8');
        this.recvBuffer += chunk;

        let idx = this.recvBuffer.indexOf('\n');
        // process complete lines only (lines end with `\n`)
        while (idx !== -1) {
            const line = this.recvBuffer.slice(0, idx + 1); // include newline
            this.recvBuffer = this.recvBuffer.slice(idx + 1);
            try {
                await this.parseData(line);
            } catch (e) {
                this.log.error(`Error processing serial data: ${(e as Error).message || e}`);
            }
            idx = this.recvBuffer.indexOf('\n');
        }
    }

    private async openPort(): Promise<void> {
        // Close existing port if open
        await this.closePort();

        try {
            this.serialPort = new SerialPort({
                path: this.config.serialPort,
                baudRate: parseInt(this.config.baudRate as string, 10) || 9600,
                autoOpen: false,
            });

            this.serialPort.open(err => {
                if (err) {
                    this.log.error(`Failed to open serial port ${this.config.serialPort}: ${err.message || err}`);
                    return;
                }
                this.log.info(`Serial port opened: ${this.config.serialPort} @ ${this.config.baudRate}`);
            });

            this.serialPort.on('data', async (data: Buffer): Promise<void> => {
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                await this.processReceivedData(data);
            });

            this.serialPort.on('error', async (err: Error): Promise<void> => {
                this.log.error(`Serial port error (${this.config.serialPort}): ${err.message || err}`);
                await this.setStateIfChangedAsync('info.connection', false);

                this.reconnectTimer ||= setTimeout(() => {
                    this.reconnectTimer = null;
                    this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                    this.openPort().catch(error => this.log.warn(`Error opening serial port: ${error.message || err}`));
                }, 5000);
            });

            this.serialPort.on('close', async (): Promise<void> => {
                this.log.info(`Serial port closed: ${this.config.serialPort}`);
                await this.setStateIfChangedAsync('info.connection', false);

                this.reconnectTimer ||= setTimeout(() => {
                    this.reconnectTimer = null;
                    this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                    this.openPort().catch((err: Error) =>
                        this.log.warn(`Error reopening serial port: ${err.message || err}`),
                    );
                }, 5000);
            });
        } catch (error) {
            // Cannot open port
            this.log.error(`Error parsing serial port: ${error.message || error}`);
            await this.setStateIfChangedAsync('info.connection', false);
            this.reconnectTimer ||= setTimeout(() => {
                this.reconnectTimer = null;
                this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                this.openPort().catch((err: Error) =>
                    this.log.warn(`Error opening serial port: ${err.message || err}`),
                );
            }, 5000);
        }
    }

    private openUdpServer(port: number = 50547): void {
        try {
            const sock = createSocket('udp4');

            sock.on('message', async (data: Buffer): Promise<void> => {
                await this.setStateIfChangedAsync('info.connection', true);
                // Just push the data to handler
                await this.processReceivedData(Buffer.from(`${data.toString()}\n`));
            });

            sock.on('error', (err: Error) => this.log.error(`UDP server error: ${err.message || err}`));

            sock.on('listening', () => {
                const address = sock.address();
                this.log.debug(
                    `UDP server listening on ${typeof address === 'string' ? address : `${address.address}:${address.port} for test purposes`}`,
                );
            });

            sock.bind(port);
            this.udpServer = sock;
        } catch (e) {
            this.log.error(`Failed to start UDP server: ${(e as Error).message || e}`);
        }
    }

    private closeUdpServer(): Promise<void> {
        if (!this.udpServer) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            try {
                this.udpServer!.close(() => {
                    this.log.info('UDP server closed');
                    this.udpServer = undefined;
                    resolve();
                });
            } catch (e) {
                this.log.warn(`Error closing UDP server: ${(e as Error).message || e}`);
                this.udpServer = undefined;
                resolve();
            }
        });
    }

    async main(): Promise<void> {
        await this.setStateAsync('info.connection', false, true);
        // Open UDP port 50547 for test purposes
        this.openUdpServer(50547);

        this.openPort().catch((err: Error) => this.log.error(`Error opening serial port: ${err.message || err}`));
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new SerialGpsAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new SerialGpsAdapter())();
}
