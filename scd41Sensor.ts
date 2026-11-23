/**
 * scd41Sensor.ts
 * 原有功能：I2C重试、看门狗自动复位、CO2/温湿度读取、就绪检测
 * 新增功能：软件复位、启动/停止周期测量、设置ASC自动校准、FRC强制校准
 * 图形块显示文本改为中文，内部逻辑完全不变
 */
const SCD41_ADDR = 0x62;

enum Cmd {
    STOP_PERIODIC_MEASUREMENT = 0x3F86,
    START_PERIODIC_MEASUREMENT = 0x21B1,
    GET_DATA_READY_STATUS = 0xE4B8,
    READ_MEASUREMENT = 0xEC05,
    SOFT_RESET = 0x3646,
    SET_AUTOMATIC_SELF_CALIBRATION = 0x2415,
    FORCED_RECALIBRATION = 0x362F
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

    // 发送命令 + 1个16位参数，带CRC
    private sendCmdWithParam(cmd: number, value: number): boolean {
        const buf = pins.createBuffer(5);
        buf[0] = (cmd >> 8) & 0xFF;
        buf[1] = cmd & 0xFF;
        buf[2] = (value >> 8) & 0xFF;
        buf[3] = value & 0xFF;
        buf[4] = crc8([buf[2], buf[3]]);
        try {
            pins.i2cWriteBuffer(SCD41_ADDR, buf, false);
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

    isDataReady(): boolean {
        if (!this._initOK) return false;
        let ready = false;
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

    tryReadOnce() {
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

    //===== 新增底层方法 =====
    /** 软件复位传感器 */
    softReset(): boolean {
        const ok = this.sendCmd(Cmd.SOFT_RESET);
        control.waitMicros(1000000);
        return ok;
    }
    /** 停止周期测量 */
    stopPeriodic(): boolean {
        const ok = this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        return ok;
    }
    /** 启动周期测量 */
    startPeriodic(): boolean {
        const ok = this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        return ok;
    }
    /** 设置ASC自动校准 true开启 / false关闭 */
    setASC(enable: boolean): boolean {
        this.stopPeriodic();
        const val = enable ? 1 : 0;
        const ok = this.sendCmdWithParam(Cmd.SET_AUTOMATIC_SELF_CALIBRATION, val);
        control.waitMicros(200000);
        return ok;
    }
    /**
     * FRC强制校准
     * refPpm：参考CO2浓度
     * 返回：修正偏移值；失败返回0xFFFF
     */
    forcedRecalibration(refPpm: number): number {
        this.stopPeriodic();
        this.sendCmdWithParam(Cmd.FORCED_RECALIBRATION, refPpm);
        control.waitMicros(400000);
        const r = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
        this.startPeriodic();
        if (r.length !== 3) return 0xFFFF;
        const check = crc8([r[0], r[1]]);
        if (check !== r[2]) return 0xFFFF;
        return (r[0] << 8) | r[1];
    }
}

let scd41 = new DFRobotSCD41();

//% weight=10 color="#0088cc" icon="\uf080"
//% block="DFRobot SCD41 二氧化碳传感器"
namespace DFRobotSCD41 {
    //===== 原有积木，仅修改显示文字为中文 =====
    //% block="初始化 SCD41 传感器"
    export function initSensor() {
        scd41.init();
    }
    //% block="SCD41 是否数据就绪？"
    export function isReady(): boolean {
        return scd41.isDataReady();
    }
    //% block="读取二氧化碳 ppm"
    export function getCO2(): number {
        return scd41.getCO2();
    }
    //% block="读取温度 ℃"
    export function getTemp(): number {
        return scd41.getTemperature();
    }
    //% block="读取湿度 %RH"
    export function getHum(): number {
        return scd41.getHumidity();
    }

    //===== 新增中文图形积木 =====
    //% block="SCD41 软件复位"
    export function softReset() {
        scd41.softReset();
    }
    //% block="SCD41 停止周期测量"
    export function stopPeriodicMeasure() {
        scd41.stopPeriodic();
    }
    //% block="SCD41 启动周期测量"
    export function startPeriodicMeasure() {
        scd41.startPeriodic();
    }
    //% block="SCD41 设置ASC自动校准 %enable"
    export function setASC(enable: boolean) {
        scd41.setASC(enable);
    }
    /**
     * FRC强制校准，传入参考CO₂ ppm，返回修正偏移量，失败0xFFFF
     */
    //% block="SCD41 FRC强制校准 参考ppm %refPpm"
    export function frcCal(refPpm: number): number {
        return scd41.forcedRecalibration(refPpm);
    }
}
