/**
 * SCD41 scd41Sensor.ts
 * 对标 DFRobot Arduino DFRobot_SCD4X
 * 修复：读3次卡死、I2C命令风暴、重复isDataReady调用
 * 机制：就绪后只读取一次，数据缓存，get函数只拿缓存，不访问I2C
 */
const SCD41_ADDR = 0x62;
enum Cmd {
    STOP_PERIODIC_MEASUREMENT = 0x3F86,
    START_PERIODIC_MEASUREMENT = 0x21B1,
    GET_DATA_READY_STATUS = 0xE4B8,
    READ_MEASUREMENT = 0xEC05
}

// Sensirion CRC8 0x31 init 0xFF
function crc8(data: number[]): number {
    let crc = 0xFF;
    for (const b of data) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x80) {
                crc = (crc << 1) ^ 0x31;
            } else {
                crc = crc << 1;
            }
            crc &= 0xFF;
        }
    }
    return crc;
}

class DFRobotSCD41 {
    private _initOK = false;
    private _co2 = 0;
    private _temp = 0.0;
    private _rh = 0.0;

    constructor() { }

    private sendCmd(cmd: number) {
        const buf = pins.createBuffer(2);
        buf[0] = (cmd >> 8) & 0xFF;
        buf[1] = cmd & 0xFF;
        pins.i2cWriteBuffer(SCD41_ADDR, buf, false);
        control.waitMicros(1000);
    }

    init(): boolean {
        this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        this._initOK = true;
        return true;
    }

    // 仅查询就绪，不读取测量值，不修改缓存
    isDataReady(): boolean {
        if (!this._initOK) return false;
        this.sendCmd(Cmd.GET_DATA_READY_STATUS);
        const recv = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
        if (recv.length < 3) return false;
        const c = crc8([recv[0], recv[1]]);
        if (c !== recv[2]) return false;
        const raw = (recv[0] << 8) | recv[1];
        return (raw & 0x8000) !== 0;
    }

    // 【重点】仅在就绪标志为true时调用一次，读取并缓存一组数据
    readOnceWhenReady(): boolean {
        if (!this._initOK || !this.isDataReady()) {
            return false;
        }
        this.sendCmd(Cmd.READ_MEASUREMENT);
        const recv = pins.i2cReadBuffer(SCD41_ADDR, 9, false);
        if (recv.length < 9) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return false;
        }

        const co2Crc = crc8([recv[0], recv[1]]);
        const tempCrc = crc8([recv[3], recv[4]]);
        const rhCrc = crc8([recv[6], recv[7]]);
        if (co2Crc !== recv[2] || tempCrc !== recv[5] || rhCrc !== recv[8]) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return false;
        }

        this._co2 = (recv[0] << 8) | recv[1];
        const rawTemp = (recv[3] << 8) | recv[4];
        const rawRh = (recv[6] << 8) | recv[7];
        this._temp = rawTemp * 175.0 / 65535.0 - 45.0;
        this._rh = rawRh * 100.0 / 65535.0;
        return true;
    }

    getCO2(): number {
        return this._co2;
    }
    getTemperature(): number {
        return this._temp;
    }
    getHumidity(): number {
        return this._rh;
    }
}

let scd41 = new DFRobotSCD41();

//% weight=10 color="#0088cc" icon="\uf080"
//% block="DFRobot SCD41 CO2 Sensor"
namespace DFRobotSCD41 {
    /**
     * Initialize SCD41 sensor
     */
    //% block="init SCD41 sensor"
    export function initSensor() {
        scd41.init();
    }

    /**
     * Check if new data ready
     */
    //% block="SCD41 data ready?"
    export function isReady(): boolean {
        return scd41.isDataReady();
    }

    /**
     * Read one group data to cache, only run once when ready=true
     */
    //% block="SCD41 read once and cache"
    export function readOnce() {
        scd41.readOnceWhenReady();
    }

    /**
     * Get CO2 concentration (ppm)
     */
    //% block="SCD41 read CO2 ppm"
    export function getCO2(): number {
        return scd41.getCO2();
    }

    /**
     * Get temperature (℃)
     */
    //% block="SCD41 read temperature ℃"
    export function getTemp(): number {
        return scd41.getTemperature();
    }

    /**
     * Get relative humidity (%)
     */
    //% block="SCD41 read humidity %"
    export function getHum(): number {
        return scd41.getHumidity();
    }
}
