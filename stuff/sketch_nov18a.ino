// ESP32 Dev Module + DS18B20 -> sends each reading to the PC over WiFi.
// Wiring: DS18B20 VDD -> 3V3, GND -> GND, DATA -> GPI23,
//         4.7k resistor between DATA and 3V3.
// Libraries: OneWire, DallasTemperature (WiFi and HTTPClient come with the ESP32 core).

#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

const char* WIFI_SSID   = "IAmRustee";
const char* WIFI_PASS   = "HotspotWifi123";
const char* SERVER_URL  = "http://10.75.43.111:5000/readings";  // Host PC's IP
const char* SENSOR_ID   = "fridge_01";


const int ONE_WIRE_PIN = 23;
const unsigned long DELAY = 30000;

OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature sensors(&oneWire);

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " failed");
}

void sendReading(float tempC) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  String body = String("{\"sensor_id\":\"") + SENSOR_ID +
                "\",\"temp_c\":" + String(tempC, 2) + "}";
  int code = http.POST(body);
  Serial.printf("%.2f C -> HTTP %d\n", tempC, code);
  http.end();
}

void setup() {
  Serial.begin(115200);
  sensors.begin();
  sensors.setResolution(12);
  connectWiFi();
}

void loop() {
  unsigned long start = millis();

  connectWiFi();  // reconnects if the link dropped
  sensors.requestTemperatures();
  float tempC = sensors.getTempCByIndex(0);
  
  if (tempC != DEVICE_DISCONNECTED_C && tempC != 85.0) {
    sendReading(tempC);
  }
  unsigned long elapsed = millis() - start;
  if (elapsed < DELAY) delay(DELAY - elapsed);
}
