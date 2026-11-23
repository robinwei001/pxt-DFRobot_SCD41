/**
 * scd41Sensor.ts
 * 原有功能：I2C重试、看门狗自动复位、CO2/温湿度读取、就绪检测
 * 新增：普通周期5s / 低功耗周期30s切换；看门狗/FRC自动恢复当前测量模式
 * 规避bug：移除block.loc.zh‑CN，block直接写中文，避免makecode编译无限转圈
 */
const SCD41_ADDR = 0x62;
// 模式常量（普通/低功耗/空闲）
const MODE_IDLE = 0;
const MODE_NORMAL_5S = 1;
const MODE_LOWPOWER_30S = 2;

enum Cmd {
    STOP_PERIODIC_MEASUREMENT = 0x3F86,
    START_PERIODIC_MEASUREMENT = 0x21B1,
    START_LOW_POWER_PERIODIC = 0x21AC,
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
    //【新增】记录当前测量模式
    private _currentMode: number = MODE_IDLE;

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
        this._currentMode = MODE_NORMAL_5S;
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
    //【修改看门狗复位：恢复记录的模式，不再固定普通周期】
    private resetSensor() {
        this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        switch (this._currentMode) {
            case MODE_NORMAL_5S:
                this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
                break;
            case MODE_LOWPOWER_30S:
                this.sendCmd(Cmd.START_LOW_POWER_PERIODIC);
                break;
            default:
                break;
        }
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
    softReset(): boolean {
        const ok = this.sendCmd(Cmd.SOFT_RESET);
        control.waitMicros(1000000);
        this._currentMode = MODE_IDLE;
        return ok;
    }
    stopPeriodic(): boolean {
        const ok = this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this._currentMode = MODE_IDLE;
        return ok;
    }
    startPeriodic(): boolean {
        const ok = this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this._currentMode = MODE_NORMAL_5S;
        return ok;
    }
    //【新增底层：启动低功耗周期测量】
    startLowPowerPeriodic(): boolean {
        const ok = this.sendCmd(Cmd.START_LOW_POWER_PERIODIC);
        control.waitMicros(500000);
        this._currentMode = MODE_LOWPOWER_30S;
        return ok;
    }
    setASC(enable: boolean): boolean {
        this.stopPeriodic();
        const val = enable ? 1 : 0;
        const ok = this.sendCmdWithParam(Cmd.SET_AUTOMATIC_SELF_CALIBRATION, val);
        control.waitMicros(200000);
        return ok;
    }
    //【修改FRC：校准结束恢复之前记录的周期模式，不再强制切普通5s】
    forcedRecalibration(refPpm: number): number {
        this.stopPeriodic();
        this.sendCmdWithParam(Cmd.FORCED_RECALIBRATION, refPpm);
        control.waitMicros(400000);
        const r = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
        //恢复之前模式
        if(this._currentMode === MODE_NORMAL_5S){
            this.startPeriodic();
        }else if(this._currentMode === MODE_LOWPOWER_30S){
            this.startLowPowerPeriodic();
        }
        if (r.length !== 3) return 0xFFFF;
        const check = crc8([r[0], r[1]]);
        if (check !== r[2]) return 0xFFFF;
        return (r[0] << 8) | r[1];
    }
}
let scd41 = new DFRobotSCD41();

//% weight=10 color="#0088cc" icon="\uf080"
//% blockNamespace="DFRobotSCD41"
//% block="DFRobot SCD41 二氧化碳传感器"
namespace DFRobotSCD41 {
    //【全部block直接写中文，删除所有 block.loc.zh‑CN，规避编译卡死】
    //% blockId="scd41_init" block="初始化 SCD41 传感器"
    export function initSensor() {
        scd41.init();
    }
    //% blockId="scd41_isready" block="SCD41 是否数据就绪？"
    export function isReady(): boolean {
        return scd41.isReady();
    }
    //% blockId="scd41_readco2" block="读取二氧化碳 ppm"
    export function getCO2(): number {
        return scd41.getCO2();
    }
    //% blockId="scd41_readtemp" block="读取温度 ℃"
    export function getTemp(): number {
        return scd41.getTemperature();
    }
    //% blockId="scd41_readhum" block="读取湿度 %RH"
    export function getHum(): number {
        return scd41.getHumidity();
    }
    //% blockId="scd41_softreset" block="SCD41 软件复位"
    export function softReset() {
        scd41.softReset();
    }
    //% blockId="scd41_stopperiodic" block="SCD41 停止周期测量"
    export function stopPeriodicMeasure() {
        scd41.stopPeriodic();
    }
    //【原有启动周期，改中文显示为普通5s】
    //% blockId="scd41_startperiodic" block="SCD41 启动普通周期测量(5s)"
    export function startPeriodicMeasure() {
        scd41.startPeriodic();
    }
    //【新增图形积木：低功耗30s】
    //% blockId="scd41_startlowpowerperiodic" block="SCD41 启动低功耗周期测量(30s)"
    export function startLowPowerPeriodicMeasure() {
        scd41.stopPeriodic();
    }
    //% blockId="scd41_setasc" block="SCD41 设置ASC自动校准 %enable"
    export function setASC(enable: boolean) {
        scd41.setASC(enable);
    }
    //% blockId="scd41_frc" block="SCD41 FRC强制校准 参考ppm %refPpm"
    export function frcCal(refPpm: number): number {
        return scd41.frcCal(refPpm);
    }
}
