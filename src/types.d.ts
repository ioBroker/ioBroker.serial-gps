export interface SerialGpsAdapterConfig {
    /** How the device is selected: by fixed port path or by stable USB device ID */
    selectBy: 'port' | 'device';
    serialPort: string;
    /** Stable USB identifier in the form `vendorId:productId:serialNumber` (used when selectBy === 'device') */
    deviceId: string;
    baudRate: number | string;
    /** Seconds: gps.* states are written at most once per this interval (0 = every received value) */
    updateInterval: number | string;
    /** Meters: position states are written only after moving at least this far (0 = off) */
    minDistance: number | string;
    /** Degrees: course is written only after changing at least this much (0 = off) */
    minCourseChange: number | string;
    /** km/h: course is written only while moving at least this fast (0 = off) */
    minCourseSpeed: number | string;
    test?: boolean;
}
