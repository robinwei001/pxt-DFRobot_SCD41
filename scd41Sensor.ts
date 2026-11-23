/**
 * scd41Sensor.ts
 * 功能:I2C重试、看门狗自动恢复周期、CO2温湿度读取
 * 功能:软复位、普通5s/低功耗30s周期切换、ASC开关、FRC强制校准
 * 修复:移除会导致makecode编译器死锁的特殊字符、顶层enum、readonly
 */
const SCD41_ADDR = 0x62;
const MODE_IDLE = 0;
const MODE_NORMAL_5S = 1;
const MODE_LOWPOWER_30S = 2;

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
    // 命令码全部移入类内部，消除顶层enum
    private readonly STOP_PERIODIC_MEASUREMENT = 0x3F86;
    private readonly START_PERIODIC_MEASUREMENT = 0x21B1;
    private readonly START_LOW_POWER_PERIODIC = 0x21AC;
    private readonly GET_DATA_READY_STATUS = 0xE4B8;
    private readonly READ_MEASUREMENT = 0xEC05;
    private readonly SOFT_RESET = 0x3646;
    private readonly SET_AUTOMATIC_SELF_CALIBRATION = 0x2415;
    private readonly FORCED_RECALIBRATION = 0x362F;

    private _initOK = false;
    private _co2 = 0;
    private _temp = 0.0;
    private _rh = 0.0;
    private _dataFetched = false;
    private _noDataCount = 0;
    private WATCHDOG_MAX = 10; //去掉readonly
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
        this.sendCmd(this.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this.sendCmd(this.START_PERIODIC_MEASUREMENT);
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
            this.sendCmd(this.GET_DATA_READY_STATUS);
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
        this.sendCmd(this.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        switch (this._currentMode) {
            case MODE_NORMAL_5S:
                this.sendCmd(this.START_PERIODIC_MEASUREMENT);
                break;
            case MODE_LOWPOWER_30S:
                this.sendCmd(this.START_LOW_POWER_PERIODIC);
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
        this.sendCmd(this.READ_MEASUREMENT);
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
        const ok = this.sendCmd(this.SOFT_RESET);
        control.waitMicros(1000000);
        this._currentMode = MODE_IDLE;
        return ok;
    }

    stopPeriodic(): boolean {
        const ok = this.sendCmd(this.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this._currentMode = MODE_IDLE;
        return ok;
    }

    startPeriodic(): boolean {
        const ok = this.sendCmd(this.START_PERIODIC_MEASUREMENT);
        control.waitMicros(500000);
        this._currentMode = MODE_NORMAL_5S;
        return ok;
    }

    startLowPowerPeriodic(): boolean {
        const ok = this.sendCmd(this.START_LOW_POWER_PERIODIC);
        control.waitMicros(500000);
        this._currentMode = MODE_LOWPOWER_30S;
        return ok;
    }

    setASC(enable: boolean): boolean {
        this.stopPeriodic();
        const val = enable ? 1 : 0;
        const ok = this.sendCmdWithParam(this.SET_AUTOMATIC_SELF_CALIBRATION, val);
        control.waitMicros(200000);
        return ok;
    }

    forcedRecalibration(refPpm: number): number {
        this.stopPeriodic();
        this.sendCmdWithParam(this.FORCED_RECALIBRATION, refPpm);
        control.waitMicros(400000);
        const r = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
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
//% block.loc.zh-CN="DFRobot SCD41 二氧化碳传感器"
namespace DFRobotSCD41 {
    //% blockId="scd41_init" block="init sensor"
    //% block.loc.zh-CN="初始化 SCD41 传感器"
    export function initSensor() {
        scd41.init();
    }
    //% blockId="scd41_isready" block="data ready?"
    //% block.loc.zh-CN="SCD41 是否数据就绪？"
    export function isReady(): boolean {
        return scd41.isReady();
    }
    //% blockId="scd41_readco2" block="read CO2 ppm"
    //% block.loc.zh-CN="读取二氧化碳 ppm"
    export function getCO2(): number {
        return scd41.getCO2();
    }
    //% blockId="scd41_readtemp" block="read temperature ℃"
    //% block.loc.zh-CN="读取温度 ℃"
    export function getTemp() {
        return scd41.getTemperature();
    }
    //% blockId="scd41_readhum" block="read humidity %RH"
    //% block.loc.zh-CN="读取湿度 %RH"
    export function getHum() {
        return scd41.getHumidity();
    }
    //% blockId="scd41_softreset" block="soft reset"
    //% block.loc.zh-CN="SCD41 软件复位"
    export function softReset() {
        scd41.softReset();
    }
    //% blockId="scd41_stopperiodic" block="stop periodic measurement"
    //% block.loc.zh-CN="SCD41 停止周期测量"
    export function stopPeriodicMeasure() {
        scd41.stopPeriodic();
    }
    //% blockId="scd41_startperiodic" block="start periodic measurement"
    //% block.loc.zh-CN="SCD41 启动普通周期测量(5s)"
    export function startPeriodicMeasure() {
        scd41.startPeriodic();
    }
    //% blockId="scd41_startlowpowerperiodic" block="start low-power periodic"
    //% block.loc.zh-CN="SCD41 启动低功耗周期测量(30s)"
    export function startLowPowerPeriodicMeasure() {
        scd41.stopPeriodic();
    }
    //% blockId="scd41_setasc" block="set ASC auto-calibration %enable"
    //% block.loc.zh-CN="SCD41 设置ASC自动校准 %enable"
    export function setASC(enable: boolean) {
        scd41.setASC(enable);
    }
    //% blockId="scd41_frc" block="FRC forced recalibration ref ppm %refPpm"
    //% block.loc.zh-CN="SCD41 FRC强制校准 参考ppm %refPpm"
    export function frcCal(refPpm: number): number {
        return scd41.frcCal(refPpm);
    }
}
