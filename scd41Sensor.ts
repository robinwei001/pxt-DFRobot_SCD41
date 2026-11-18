/**
 * SCD41 scd41Sensor.ts
 * 对标 DFRobot Arduino DFRobot_SCD4X 库时序
 * 修复：NaN问题、I2C repeated模式、CRC校验、时序
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
        // repeated=false：发STOP，和Arduino Wire逻辑一致
        pins.i2cWriteBuffer(SCD41_ADDR, buf, false);
        control.waitMicros(1000); // 命令后等待1ms
    }

    init(): boolean {
        // 对标Arduino begin时序：先停止测量
        this.sendCmd(Cmd.STOP_PERIODIC_MEASUREMENT);
        control.waitMicros(500000); // 500ms

        this.sendCmd(Cmd.START_PERIODIC_MEASUREMENT);
        this._initOK = true;
        return true;
    }

    isDataReady(): boolean {
        if (!this._initOK) return false;
        this.sendCmd(Cmd.GET_DATA_READY_STATUS);
        const recv = pins.i2cReadBuffer(SCD41_ADDR, 3, false);
        // 长度保护
        if (recv.length < 3) return false;
        const c = crc8([recv[0], recv[1]]);
        if (c !== recv[2]) return false;
        const raw = (recv[0] << 8) | recv[1];
        return (raw & 0x8000) !== 0;
    }

    readMeasurement() {
        // 兜底：未就绪/未初始化，全部置0，杜绝undefined
        if (!this._initOK || !this.isDataReady()) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return;
        }
        this.sendCmd(Cmd.READ_MEASUREMENT);
        const recv = pins.i2cReadBuffer(SCD41_ADDR, 9, false);
        // 关键：buffer长度不足直接失败赋值0，防止访问undefined
        if (recv.length < 9) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return;
        }

        // CO2 CRC
        const co2Crc = crc8([recv[0], recv[1]]);
        if (co2Crc !== recv[2]) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return;
        }
        // Temp CRC
        const tempCrc = crc8([recv[3], recv[4]]);
        if (tempCrc !== recv[5]) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return;
        }
        // RH CRC
        const rhCrc = crc8([recv[6], recv[7]]);
        if (rhCrc !== recv[8]) {
            this._co2 = 0;
            this._temp = 0;
            this._rh = 0;
            return;
        }

        // 有效数据，计算，公式和Arduino库完全对齐
        this._co2 = (recv[0] << 8) | recv[1];
        const rawTemp = (recv[3] << 8) | recv[4];
        const rawRh = (recv[6] << 8) | recv[7];
        this._temp = rawTemp * 175.0 / 65535.0 - 45.0;
        this._rh = rawRh * 100.0 / 65535.0;
    }

    getCO2(): number {
        this.readMeasurement();
        return this._co2;
    }

    getTemperature(): number {
        this.readMeasurement();
        return this._temp;
    }

    getHumidity(): number {
        this.readMeasurement();
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

    /**
     * Check if new data ready
     */
    //% block="SCD41 data ready?"
    export function isReady(): boolean {
        return scd41.isDataReady();
    }
}
