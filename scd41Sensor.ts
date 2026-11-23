/**
 * scd41Sensor.ts
 * 增加I2C重试 + 看门狗自动复位，兼容原有全部积木
 * 解决：查询几次后I2C卡死不再刷新
 */
const SCD41_ADDR = 0x62;
enum Cmd {
    STOP_PERIODIC_MEASUREMENT = 0x3F86,
    START_PERIODIC_MEASUREMENT = 0x21B1,
    GET_DATA_READY_STATUS = 0xE4B8,
    READ_MEASUREMENT = 0xEC05
}

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
    private _dataFetched = false;
    private _noDataCount = 0;
    // 连续10次查不到就绪，自动复位传感器
    private readonly WATCHDOG_MAX = 10;

    constructor() { }

    private sendCmd(cmd: number): boolean {
        const buf = pins.createBuffer(2);
        buf[0] = (cmd >> 8) & 0xFF;
        buf[1] = cmd & 0xFF;
        try {
            pins.i2cWriteBuffer(SCD41_ADDR, buf, false);
            control.waitMicros(1000);
            return true;
        } catch (e) {
            return false;
        }
    }

    init(): boolean {
        this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        this._initOK = true;
        this._dataFetched = false;
        this._noDataCount = 0;
        return true;
    }

    // 带重试的就绪查询
    isDataReady(): boolean {
        if (!this._initOK) return false;

        let ready = false;
        // 最多重试2次
        for (let retry = 0; retry < 3; retry++) {
            this.sendCmd(Cmd.GET_DATA_READY_STATUS);
            const recv = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
            if (recv.length >= 3) {
                const c = crc8([recv[0], recv[1]]);
                if (c === recv[2]) {
                    const raw = (recv[0] << 8) | recv[1];
                    ready = (raw & 0x8000) !== 0;
                    break;
                }
            }
            control.waitMicros(500);
        }

        if (ready) {
            this._dataFetched = false;
            this._noDataCount = 0;
        } else {
            this._noDataCount += 1;
            // 看门狗：长期无数据，自动重启测量
            if (this._noDataCount >= this.WATCHDOG_MAX) {
                this.resetSensor();
                this._noDataCount = 0;
            }
        }
        return ready;
    }

    private resetSensor() {
        this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        this._dataFetched = false;
    }

    private tryReadOnce() {
        if (!this._initOK || this._dataFetched) {
            return;
        }
        this.sendCmd(Cmd.READ_MEASUREMENT);
        const recv = pins.i2cReadBuffer(SCD41_ADDR, 9, false);
        if (recv.length < 9) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            this._dataFetched = true;
            return;
        }
        const co2Crc = crc8([recv[0], recv[1]]);
        const tempCrc = crc8([recv[3], recv[4]]);
        const rhCrc = crc8([recv[6], recv[7]]);
        if (co2Crc !== recv[2] || tempCrc !== recv[5] || rhCrc !== recv[8]) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            this._dataFetched = true;
            return;
        }
        this._co2 = (recv[0] << 8) | recv[1];
        const rawTemp = (recv[3] << 8) | recv[4];
        const rawRh = (recv[6] << 8) | recv[7];
        this._temp = rawTemp * 175.0 / 65535.0 - 45.0;
        this._rh = rawRh * 100.0 / 65535.0;
        this._dataFetched = true;
    }

    getCO2(): number {
        this.tryReadOnce();
        return this._co2;
    }
    getTemperature(): number {
        this.tryReadOnce();
        return this._temp;
    }
    getHumidity(): number {
        this.tryReadOnce();
        return this._rh;
    }
}

let scd41 = new DFRobotSCD41();

//% weight=10 color="#0088cc" icon="\uf080"
//% block="DFRobot SCD41 CO2 Sensor"
namespace DFRobotSCD41 {
    //% block="init SCD41 sensor"
    export function initSensor() {
        scd41.init();
    }
    //% block="SCD41 data ready?"
    export function isReady(): boolean {
        return scd41.isDataReady();
    }
    //% block="SCD41 read CO2 ppm"
    export function getCO2(): number {
        return scd41.getCO2();
    }
    //% block="SCD41 read temperature ℃"
    export function getTemp(): number {
        return scd41.getTemperature();
    }
    //% block="SCD41 read humidity %"
    export function getHum(): number {
        return scd41.getHumidity();
    }
}
