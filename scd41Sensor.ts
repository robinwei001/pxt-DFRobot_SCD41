
//% weight=100 color=#9999FF icon="\uf2f1" block="SCD41 Infrared CO2 Sensor (SEN0536)"
// Faithful port of the Arduino DFRobot_SCD4X library to MakeCode/pxt.
namespace scd41Sensor {

    export enum BeginPara {
        //% blockId="scd41Sensor_Elevation" block="Elevation"
        Elevation,
        //% blockId="scd41Sensor_Pressure" block="Air Pressure"
        Pressure,
    }

    export enum MeasureStatus {
        //% blockId="scd41Sensor_Start" block="Start"
        Start,
        //% blockId="scd41Sensor_Stop" block="Stop"
        Stop,
    }

    export enum MeasureData {
        //% blockId="scd41Sensor_Temperature" block="Temperature"
        Temperature,
        //% blockId="scd41Sensor_Humidity" block="Humidity"
        Humidity,
        //% blockId="scd41Sensor_CO2" block="CO2"
        CO2,
    }

    /* ---- commands, identical to DFRobot_SCD4X.h ---- */
    const SCD4X_I2C_ADDR              = 0x62;
    const SCD4X_START_PERIODIC_MEASURE = 0x21b1;
    const SCD4X_READ_MEASUREMENT       = 0xec05;
    const SCD4X_STOP_PERIODIC_MEASURE  = 0x3f86;
    const SCD4X_SET_SENSOR_ALTITUDE    = 0x2427;
    const SCD4X_SET_AMBIENT_PRESSURE  = 0xe000;
    const SCD4X_GET_DATA_READY_STATUS  = 0xe4b8;
    const SCD4X_GET_SERIAL_NUMBER      = 0x3682;

    const SCD4X_CRC8_INIT       = 0xFF;
    const SCD4X_CRC8_POLYNOMIAL = 0x31;

    /* ---- diagnostic error codes ---- */
    const ERR_OK          = 0;
    const ERR_NACK        = 1;  // write to 0x62 was not acknowledged
    const ERR_SHORT_READ  = 2;  // read returned fewer bytes than requested
    const ERR_NOT_READY    = 4;  // FIFO empty, no new sample
    const ERR_NOT_STARTED = 5; // periodic measurement not started yet

    let temp = NaN;
    let humi = NaN;
    let co2ppm = NaN;
    let started = false;
    let lastError = ERR_OK;

    /**
     * Check whether the sensor acknowledges its I2C address (0x62).
     */
    //% blockId=scd41Sensor_isConnected block="SCD41 connected?"
    //% weight=90
    export function isConnected(): boolean {
        const b = pins.createBuffer(1);
        b.setNumber(NumberFormat.UInt8LE, 0, 0);
        return pins.i2cWriteBuffer(SCD4X_I2C_ADDR, b, false) == 0;
    }

    /**
     * Last diagnostic code: 0 ok, 1 NACK, 2 short read, 4 not ready, 5 not started.
     */
    //% blockId=scd41Sensor_errorCode block="SCD41 last error code"
    //% weight=30
    export function errorCode(): number {
        return lastError;
    }

    /**
     * Initialize the sensor (mirrors Arduino begin(): stop periodic measurement,
     * wait 500ms, read serial number, apply compensation). Does NOT start sampling;
     * call measure(Start) afterwards, exactly like the Arduino example setup().
     * @param value compensation value (altitude in m, or pressure in Pa)
     * @param para choose whether value is elevation or air pressure
     */
    //% blockId=scd41Sensor_begin block="SCD41 Init %value %para"
    //% weight=100
    export function begin(value: number, para: BeginPara): void {
        lastError = ERR_OK;

        // Arduino: enablePeriodMeasure(STOP_PERIODIC_MEASURE) then delay(500).
        enablePeriodMeasure(SCD4X_STOP_PERIODIC_MEASURE);

        // Arduino: getSerialNumber() as a communication check (best effort here).
        readSerialNumber();

        if (para == BeginPara.Elevation) {
            writeData(SCD4X_SET_SENSOR_ALTITUDE, pack(value));
        } else if (para == BeginPara.Pressure) {
            writeData(SCD4X_SET_AMBIENT_PRESSURE, pack(Math.ceil(value / 100)));
        }
        basic.pause(1);
    }

    /**
     * Start / stop periodic measurement (mirrors Arduino enablePeriodMeasure).
     * @param status Start / Stop
     */
    //% blockId=scd41Sensor_measure block="SCD41 %status measure"
    //% weight=80
    export function measure(status: MeasureStatus): void {
        if (status == MeasureStatus.Start) {
            enablePeriodMeasure(SCD4X_START_PERIODIC_MEASURE);
            started = true;
        } else if (status == MeasureStatus.Stop) {
            enablePeriodMeasure(SCD4X_STOP_PERIODIC_MEASURE);
            started = false;
        }
    }

    /**
     * Mirrors Arduino getDataReadyStatus() + readMeasurement():
     * poll ready flag, and only when ready read the 9-byte frame.
     * @returns true when a valid new frame has been latched
     */
    //% blockId=scd41Sensor_getStatus block="Is the sensor data updated?"
    //% weight=60
    export function getStatus(): boolean {
        if (!started) {
            lastError = ERR_NOT_STARTED;
            return false;
        }

        // 1. data ready status (Arduino getDataReadyStatus)
        const st = readData(SCD4X_GET_DATA_READY_STATUS, 3);
        if (lastError != ERR_OK) return false;
        const statusWord = byteToWord(st[0], st[1]);
        if ((statusWord & 0x7FF) == 0) {
            lastError = ERR_NOT_READY;
            return false;
        }

        // 2. read measurement (Arduino readMeasurement): CO2, T, RH
        const m = readData(SCD4X_READ_MEASUREMENT, 9);
        if (lastError != ERR_OK) return false;

        co2ppm = byteToWord(m[0], m[1]);
        const rawTemp = byteToWord(m[3], m[4]);
        const rawHumi = byteToWord(m[6], m[7]);

        // Same scaling as Arduino DFRobot_SCD4X.cpp
        temp = -45 + 175 * rawTemp / 65535;
        humi = 100 * rawHumi / 65535;
        lastError = ERR_OK;
        return true;
    }

    /**
     * Get the last latched value (NaN if no valid frame yet).
     * @param data Temperature / Humidity / CO2
     */
    //% blockId=scd41Sensor_getdata block="get %data"
    //% weight=40
    export function getdata(data: MeasureData): number {
        if (data == MeasureData.Temperature) return temp;
        if (data == MeasureData.Humidity) return humi;
        return co2ppm;
    }

    /* ---------------- internal helpers ---------------- */

    function enablePeriodMeasure(mode: number): void {
        writeData(mode, []);
        if (SCD4X_STOP_PERIODIC_MEASURE == mode) {
            basic.pause(500);   // Arduino delay(500) after stop
        }
    }

    function readSerialNumber(): void {
        readData(SCD4X_GET_SERIAL_NUMBER, 9);
    }

    function pack(data: number): number[] {
        const hi = (data >> 8) & 0xFF;
        const lo = data & 0xFF;
        return [hi, lo, calcCRC(hi, lo)];
    }

    /**
     * Sensirion CRC8 (identical to Arduino calcCRC): poly 0x31, init 0xFF.
     */
    function calcCRC(hi: number, lo: number): number {
        let crc = SCD4X_CRC8_INIT;
        const buf = [hi, lo];
        for (let currentByte = 0; currentByte < 2; currentByte++) {
            crc = crc ^ buf[currentByte];
            for (let crcbit = 8; crcbit > 0; crcbit--) {
                if (crc & 0x80) {
                    crc = ((crc << 1) & 0xFF) ^ SCD4X_CRC8_POLYNOMIAL;
                } else {
                    crc = ((crc << 1) & 0xFF);
                }
            }
        }
        return crc;
    }

    function byteToWord(msb: number, lsb: number): number {
        return (msb << 8) | lsb;
    }

    /**
     * Send a 16-bit command, wait 1ms for the sensor to prepare, then read `len` bytes.
     * The command write ends with a STOP (repeated=false), matching the Arduino
     * endTransmission() -> requestFrom() transaction. Sets lastError on failure.
     */
    function readData(reg: number, len: number): Buffer {
        const w = pins.createBuffer(2);
        w.setNumber(NumberFormat.UInt8LE, 0, (reg >> 8) & 0xFF);
        w.setNumber(NumberFormat.UInt8LE, 1, reg & 0xFF);
        const wres = pins.i2cWriteBuffer(SCD4X_I2C_ADDR, w, false);
        if (wres != 0) {
            lastError = ERR_NACK;
            return pins.createBuffer(len);
        }
        basic.pause(1);   // SCD4x command execution time (1 ms)
        const r = pins.i2cReadBuffer(SCD4X_I2C_ADDR, len, false);
        if (!r || r.length < len) {
            lastError = ERR_SHORT_READ;
            return pins.createBuffer(len);
        }
        return r;
    }

    /**
     * Write a 16-bit command plus optional payload bytes (word + CRC).
     */
    function writeData(cmd: number, payload: number[]): void {
        const total = 2 + payload.length;
        const b = pins.createBuffer(total);
        b.setNumber(NumberFormat.UInt8LE, 0, (cmd >> 8) & 0xFF);
        b.setNumber(NumberFormat.UInt8LE, 1, cmd & 0xFF);
        for (let i = 0; i < payload.length; i++) {
            b.setNumber(NumberFormat.UInt8LE, 2 + i, payload[i] & 0xFF);
        }
        const res = pins.i2cWriteBuffer(SCD4X_I2C_ADDR, b, false);
        if (res != 0) lastError = ERR_NACK;
    }
}
