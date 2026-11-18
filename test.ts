// Example mirroring the Arduino periodMeasure.ino flow on micro:bit.
// Wiring (micro:bit default I2C): VCC->3.3V, GND->GND, SCL->P19, SDA->P20.
// Serial monitor at 115200 baud (micro:bit USB CDC default).

// Optional: I2C bus scan at startup. The SCD41 must show 0x62 (decimal 98).
function scanI2C(): void {
    serial.writeLine("--- I2C scan ---")
    let found = 0
    for (let addr = 0x08; addr <= 0x77; addr++) {
        let b = pins.createBuffer(1)
        b.setNumber(NumberFormat.UInt8LE, 0, 0)
        if (pins.i2cWriteBuffer(addr, b, false) == 0) {
            serial.writeLine("ACK 0x" + addr.toString(16) + " (" + addr + ")")
            found++
        }
    }
    serial.writeLine("devices found: " + found)
}

scanI2C()

// Arduino setup(): begin() then enablePeriodMeasure(START).
scd41Sensor.begin(540, scd41Sensor.BeginPara.Elevation)
scd41Sensor.measure(scd41Sensor.MeasureStatus.Start)

// First valid sample arrives about 5 s after periodic measurement starts.
basic.pause(5000)

basic.forever(function () {
    if (!scd41Sensor.isConnected()) {
        serial.writeLine("not connected (NACK). check wiring / 3.3V / SDA=20 SCL=19. code=" + scd41Sensor.errorCode())
    } else if (scd41Sensor.getStatus()) {
        serial.writeLine("CO2(ppm): " + scd41Sensor.getdata(scd41Sensor.MeasureData.CO2))
        serial.writeLine("Temp(C):  " + scd41Sensor.getdata(scd41Sensor.MeasureData.Temperature))
        serial.writeLine("RH(%):    " + scd41Sensor.getdata(scd41Sensor.MeasureData.Humidity))
    } else {
        // code 2 short read, 4 not ready (normal before first sample), 5 not started
        serial.writeLine("no new data, code=" + scd41Sensor.errorCode())
    }
    basic.pause(1000)
})
