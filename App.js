import { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { LineChart } from "react-native-chart-kit";


// IPv4 address of host server (same address the ESP32 posts to, port 5000)
const API = "http://10.75.43.111:5000";

const POLL_MS = 10000; // ask the server for new readings every 10 sec
const STALE_S = 90; // ESP32 sends every ~30 s; 3 missed readings = sensor offline

// Colors
const C = {
  bg: "#EAF1F4",
  ink: "#0F2A33",
  muted: "#5B7480",
  line: "#D3E0E6",
  surface: "#FFFFFF",
  safe: "#0E7C7B",
  warn: "#B45309",
  bad: "#B42318",
  cold: "#1D4ED8",
};

const STATUS = {
  normal: {
    color: C.safe,
    icon: "✓",
    title: "Normal",
    msg: "Fridge is within the safe 2–8°C range.",
  },
  warning: {
    color: C.warn,
    icon: "!",
    title: "Warning",
    msg: "Temperature is close to the limit. Check the fridge.",
  },
  excursion: {
    color: C.bad,
    icon: "✕",
    title: "Excursion alert",
    msg: "Temperature is outside 2–8°C. Check the fridge now.",
  },
  nodata: {
    color: C.muted,
    icon: "?",
    title: "No recent data",
    msg: "",
  },
};

const fmt = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// "45 sec", "12 min", "1 h 5 min"
function ago(seconds) {
  if (seconds < 120) return `${Math.max(0, Math.round(seconds))} sec`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Rate of change in °C per minute: latest reading vs. the reading closest to
// 1 minute earlier (same idea as rate_of_change_1m in the backend/model).
// Returns null if there is no reading from about a minute ago.
function getRate(readings) {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  let best = null;
  for (let i = readings.length - 2; i >= 0; i--) {
    const age = last.created_at - readings[i].created_at;
    if (age > 75) break; // 60 s + 15 s tolerance
    if (age <= 0) continue;
    if (best === null || Math.abs(age - 60) < Math.abs(best.age - 60)) {
      best = { age, temperature: readings[i].temperature };
    }
  }
  if (best === null) return null;
  return (last.temperature - best.temperature) / (best.age / 60);
}

// Thermometer-style scale: shows where the temperature sits vs. the 2–8°C safe band
function Gauge({ value }) {
  const MIN = 0;
  const MAX = 12;
  const pos = (v) => Math.max(0, Math.min(100, ((v - MIN) / (MAX - MIN)) * 100));
  return (
    <View style={{ marginTop: 18 }}>
      <View style={styles.gaugeTrack}>
        <View
          style={[
            styles.gaugeSafe,
            { left: `${pos(2)}%`, width: `${pos(8) - pos(2)}%` },
          ]}
        />
        {value != null && (
          <View style={[styles.gaugeMarker, { left: `${pos(value)}%` }]} />
        )}
      </View>
      <View style={styles.gaugeLabels}>
        <Text style={[styles.gaugeLabel, { left: `${pos(2)}%` }]}>2°C</Text>
        <Text style={[styles.gaugeLabel, { left: `${pos(8)}%` }]}>8°C</Text>
      </View>
      <Text style={styles.gaugeCaption}>Safe range for vaccines: 2–8°C</Text>
    </View>
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const contentWidth = Math.min(width, 720);
  const [readings, setReadings] = useState([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false); // got at least one good response
  const [now, setNow] = useState(Date.now());
  // server clock minus phone clock (ms), so "how old is the last reading"
  // isn't thrown off if the phone and laptop clocks disagree
  const [clockOffset, setClockOffset] = useState(0);

  const load = async () => {
    try {
      const res = await fetch(`${API}/readings`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      const serverTime = Date.parse(res.headers.get("date") || "");
      if (!Number.isNaN(serverTime)) setClockOffset(serverTime - Date.now());
      setReadings(data);
      setLoaded(true);
      setError(false);
    } catch (e) {
      setError(true);
    }
    setNow(Date.now());
  };

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const latest = readings[readings.length - 1];
  const ageS = latest ? (now + clockOffset) / 1000 - latest.created_at : null;
  const noData = !latest || ageS > STALE_S;

  let s;
  if (noData) {
    s = {
      ...STATUS.nodata,
      title: !latest && !loaded ? "Connecting..." : STATUS.nodata.title,
      msg: !latest
        ? loaded
          ? "No readings yet. Waiting for the ESP32 to send data."
          : "Loading readings..."
        : `Last reading was ${ago(ageS)} ago. Check the ESP32 and its WiFi.`,
    };
  } else {
    s = STATUS[latest.status] || STATUS.nodata;
  }

  const rate = noData ? null : getRate(readings);
  const rateIcon = rate === null ? "" : rate > 0.05 ? "↑" : rate < -0.05 ? "↓" : "→";
  const rateText =
    rate === null ? "--" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}°C/min`;
  const rateNote = noData
    ? "No recent data"
    : rate === null
    ? "Waiting for more readings"
    : rate > 0.05
    ? "Getting warmer"
    : rate < -0.05
    ? "Getting colder"
    : "Stable";

  const temps = readings.map((r) => r.temperature);
  const low = temps.length ? Math.min(...temps) : null;
  const high = temps.length ? Math.max(...temps) : null;
  const recent = [...readings].reverse().slice(0, 15);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ alignItems: "center", paddingBottom: 32 }}
    >
      <View style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.appName}>ColdGuard</Text>
            <Text style={styles.appSub}>Vaccine fridge monitor</Text>
          </View>
          <Text style={[styles.updated, error && { color: C.bad, fontWeight: "700" }]}>
            {error
              ? "Offline"
              : latest
              ? `Updated ${fmt(latest.created_at)}`
              : loaded
              ? "No data"
              : "Loading..."}
          </Text>
        </View>

        {/* 1. Excursion Alert panel (top) */}
        <View style={[styles.alert, { backgroundColor: s.color }]}>
          <View style={styles.alertIcon}>
            <Text style={[styles.alertIconText, { color: s.color }]}>{s.icon}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.alertTitle}>{s.title}</Text>
            <Text style={styles.alertMsg}>{s.msg}</Text>
          </View>
        </View>

        {error && (
          <Text style={styles.error}>
            Can't reach the server. Check the IP address, WiFi, and that server.py is running.
          </Text>
        )}

        {/* 2. Current Fridge Statistics */}
        <View style={styles.section}>
          <Text style={styles.heading}>Current fridge statistics</Text>

          <View style={styles.statsRow}>
            <View style={styles.statMain}>
              <Text style={styles.statLabel}>
                {latest && noData ? "Last known temperature" : "Temperature"}
              </Text>
              <Text style={[styles.bigNumber, { color: s.color }]}>
                {latest ? latest.temperature.toFixed(1) : "--"}
                <Text style={styles.unit}>°C</Text>
              </Text>
            </View>
            <View style={styles.statSide}>
              <Text style={styles.statLabel}>Rate of change</Text>
              <Text style={styles.rate}>
                {rateIcon} {rateText}
              </Text>
              <Text style={styles.rateNote}>{rateNote}</Text>
            </View>
          </View>

          <Gauge value={latest && !noData ? latest.temperature : null} />

          <View style={styles.minmax}>
            <Text style={styles.minmaxText}>
              Lowest this hour:{" "}
              <Text style={styles.minmaxBold}>{low !== null ? `${low.toFixed(1)}°C` : "--"}</Text>
            </Text>
            <Text style={styles.minmaxText}>
              Highest this hour:{" "}
              <Text style={styles.minmaxBold}>{high !== null ? `${high.toFixed(1)}°C` : "--"}</Text>
            </Text>
          </View>
        </View>

        {/* 3. Readings in the Past Hour: chart + list */}
        <View style={styles.section}>
          <Text style={styles.heading}>Readings in the past hour</Text>

          {readings.length >= 2 ? (
            <>
              <LineChart
                data={{
                  labels: readings.map((r, i) => (i % 24 === 0 ? fmt(r.created_at) : "")),
                  datasets: [
                    { data: temps, color: () => C.ink, strokeWidth: 3 },
                    { data: temps.map(() => 8), color: () => C.bad, strokeWidth: 1.5, withDots: false },
                    { data: temps.map(() => 2), color: () => C.cold, strokeWidth: 1.5, withDots: false },
                  ],
                }}
                width={contentWidth - 24 - 32}
                height={230}
                yAxisSuffix="°"
                withDots={false}
                withShadow={false}
                withVerticalLines={false}
                chartConfig={{
                  backgroundGradientFrom: C.surface,
                  backgroundGradientTo: C.surface,
                  decimalPlaces: 0,
                  color: () => C.ink,
                  labelColor: () => C.muted,
                  propsForBackgroundLines: { stroke: C.line },
                }}
                style={{ marginLeft: -8 }}
              />
              <Text style={styles.legend}>
                Limit lines: 8°C upper (red), 2°C lower (blue)
              </Text>
            </>
          ) : (
            // (a line chart can't draw fewer than 2 points)
            <Text style={styles.empty}>
              {readings.length === 1
                ? "Only one reading so far. The chart appears after the next one."
                : "No readings yet. Waiting for the ESP32 to send data."}
            </Text>
          )}

          {/* Latest readings table */}
          {recent.length > 0 && (
            <View style={{ marginTop: 16 }}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, { flex: 1 }]}>Time</Text>
                <Text style={[styles.th, { flex: 1 }]}>Temperature</Text>
                <Text style={[styles.th, { flex: 1, textAlign: "right" }]}>Status</Text>
              </View>
              {recent.map((r, i) => {
                const st = STATUS[r.status] || STATUS.nodata;
                return (
                  <View key={`${r.created_at}-${i}`} style={styles.tr}>
                    <Text style={[styles.td, { flex: 1 }]}>{fmt(r.created_at)}</Text>
                    <Text style={[styles.td, { flex: 1, fontWeight: "700" }]}>
                      {r.temperature.toFixed(1)}°C
                    </Text>
                    <View style={{ flex: 1, alignItems: "flex-end" }}>
                      <View style={[styles.pill, { backgroundColor: st.color }]}>
                        <Text style={styles.pillText}>
                          {st.icon} {r.status}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
              <Text style={styles.legend}>
                Showing the latest {recent.length} of {readings.length} readings from the past hour
              </Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  page: { width: "100%", maxWidth: 720, padding: 12, paddingTop: 48 },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  appName: { fontSize: 28, fontWeight: "800", color: C.ink, letterSpacing: -0.5 },
  appSub: { fontSize: 14, color: C.muted, marginTop: 2 },
  updated: { fontSize: 13, color: C.muted },

  alert: {
    flexDirection: "row",
    alignItems: "center",
    padding: 18,
    borderRadius: 18,
    marginBottom: 12,
  },
  alertIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  alertIconText: { fontSize: 28, fontWeight: "900" },
  alertTitle: { fontSize: 24, fontWeight: "800", color: "#fff" },
  alertMsg: { fontSize: 15, color: "#fff", marginTop: 3 },
  error: { color: C.bad, marginBottom: 10, paddingHorizontal: 4, fontWeight: "600" },

  section: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  heading: { fontSize: 17, fontWeight: "800", color: C.ink, marginBottom: 12 },

  statsRow: { flexDirection: "row", alignItems: "flex-start" },
  statMain: { flex: 1.2 },
  statSide: { flex: 1, paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: C.line },
  statLabel: { fontSize: 14, color: C.muted },
  bigNumber: { fontSize: 52, fontWeight: "800", letterSpacing: -1.5, marginTop: 2 },
  unit: { fontSize: 24, fontWeight: "700" },
  rate: { fontSize: 22, fontWeight: "800", color: C.ink, marginTop: 8 },
  rateNote: { fontSize: 13, color: C.muted, marginTop: 4 },

  gaugeTrack: {
    height: 14,
    borderRadius: 7,
    backgroundColor: "#DCE7EC",
    justifyContent: "center",
  },
  gaugeSafe: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: C.safe,
    opacity: 0.35,
  },
  gaugeMarker: {
    position: "absolute",
    top: -6,
    width: 8,
    height: 26,
    marginLeft: -4,
    borderRadius: 4,
    backgroundColor: C.ink,
    borderWidth: 2,
    borderColor: "#fff",
  },
  gaugeLabels: { height: 18, marginTop: 10 },
  gaugeLabel: { position: "absolute", width: 36, marginLeft: -18, textAlign: "center", fontSize: 12, color: C.muted },
  gaugeCaption: { fontSize: 12, color: C.muted, marginTop: 2 },

  minmax: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  minmaxText: { fontSize: 13, color: C.muted },
  minmaxBold: { fontWeight: "700", color: C.ink },

  legend: { fontSize: 12, color: C.muted, marginTop: 8 },
  empty: { fontSize: 14, color: C.muted, lineHeight: 20 },

  tableHead: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  th: { fontSize: 13, color: C.muted, fontWeight: "600" },
  tr: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#EEF3F5",
  },
  td: { fontSize: 15, color: C.ink },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pillText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
