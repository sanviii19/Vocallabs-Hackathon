import { useEffect, useRef, useState } from "react";
import type {
  DecisionLogEntry,
  MockNotification,
  Rider,
  RiderRuntimeState,
  ServerMessage,
  Zone,
} from "../../src/types";

const MAX_LOG = 60;

export function App() {
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [simTime, setSimTime] = useState(0);
  const [zones, setZones] = useState<Zone[]>([]);
  const [riders, setRiders] = useState<Record<string, Rider>>({});
  const [runtime, setRuntime] = useState<Record<string, RiderRuntimeState>>({});
  const [decisions, setDecisions] = useState<DecisionLogEntry[]>([]);
  const [notifications, setNotifications] = useState<MockNotification[]>([]);
  const [selectedRider, setSelectedRider] = useState("");
  const [selectedZone, setSelectedZone] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (evt) => {
      const msg: ServerMessage = JSON.parse(evt.data);
      if (msg.type === "snapshot") {
        setSimTime(msg.data.simTime);
        setRunning(msg.data.running);
        setZones(msg.data.zones);
        setRiders(Object.fromEntries(msg.data.riders.map((r) => [r.id, r])));
        setRuntime(Object.fromEntries(msg.data.runtime.map((r) => [r.riderId, r])));
        setDecisions([...msg.data.recentDecisions].reverse().slice(0, MAX_LOG));
        setNotifications([...msg.data.recentNotifications].reverse().slice(0, MAX_LOG));
        if (!selectedRider && msg.data.riders[0]) setSelectedRider(msg.data.riders[0].id);
        if (!selectedZone && msg.data.zones[0]) setSelectedZone(msg.data.zones[0].id);
      } else if (msg.type === "decision") {
        setDecisions((prev) => [msg.data, ...prev].slice(0, MAX_LOG));
      } else if (msg.type === "notification") {
        setNotifications((prev) => [msg.data, ...prev].slice(0, MAX_LOG));
      } else if (msg.type === "rider_update") {
        setRiders((prev) => ({ ...prev, [msg.data.rider.id]: msg.data.rider }));
        setRuntime((prev) => ({ ...prev, [msg.data.runtime.riderId]: msg.data.runtime }));
      }
    };

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startSimulation() {
    await fetch("/api/start", { method: "POST" });
  }

  async function stopSimulation() {
    await fetch("/api/stop", { method: "POST" });
  }

  async function injectIncident() {
    if (!selectedRider) return;
    await fetch("/api/inject-incident", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riderId: selectedRider }),
    });
  }

  async function injectOutage() {
    if (!selectedZone) return;
    await fetch("/api/inject-outage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoneId: selectedZone }),
    });
  }

  const riderList = Object.values(riders).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <header>
        <h1>Field Agent Check-In</h1>
        <span className="meta">sim t={Math.floor(simTime)}s</span>
        <span className={`tier ${running ? "tier-NOMINAL" : "tier-PEER_CHECK"}`}>{running ? "RUNNING" : "STOPPED"}</span>
        <span className="meta">{connected ? "connected" : "disconnected"}</span>
      </header>

      <main>
        <section className="panel">
          <h2>Demo Controls (test harness only — not a dispatcher approval step)</h2>
          <div className="controls">
            <button onClick={startSimulation} disabled={running}>Start Simulation</button>
            <button onClick={stopSimulation} disabled={!running}>Stop Simulation</button>
          </div>
          <div className="controls" style={{ marginTop: 10 }}>
            <select value={selectedRider} onChange={(e) => setSelectedRider(e.target.value)}>
              {riderList.map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.id})</option>
              ))}
            </select>
            <button onClick={injectIncident} disabled={!running}>Inject Incident</button>

            <select value={selectedZone} onChange={(e) => setSelectedZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
            <button onClick={injectOutage} disabled={!running}>Simulate Zone Outage</button>
          </div>
        </section>

        <section className="panel">
          <h2>What The Tiers Mean</h2>
          <table>
            <thead>
              <tr><th>Tier</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="tier tier-NOMINAL">NOMINAL</span></td>
                <td>Pinging in as expected. Nothing to watch.</td>
              </tr>
              <tr>
                <td><span className="tier tier-SOFT_WATCH">SOFT_WATCH</span></td>
                <td>Silence is running a bit longer than this spot's usual dead-zone pattern. System sent a quiet "tap to confirm you're safe" check and is watching — no one else is told yet.</td>
              </tr>
              <tr>
                <td><span className="tier tier-CUSTOMER_NOTIFY">CUSTOMER_NOTIFY</span></td>
                <td>Still unresolved. The customer's been sent a "delivery delayed, we're monitoring" message so they aren't left wondering.</td>
              </tr>
              <tr>
                <td><span className="tier tier-PEER_CHECK">PEER_CHECK</span></td>
                <td>Anomaly is high enough (or nothing resolved in time) that the nearest other rider has been asked to physically look for them.</td>
              </tr>
              <tr>
                <td><span className="tier tier-EMERGENCY">EMERGENCY</span></td>
                <td>High-confidence incident. Automated call to the rider, then to their emergency contact, then an incident report is filed — all simulated/logged in this demo, no real call or SMS is sent.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Fleet</h2>
          <table>
            <thead>
              <tr>
                <th>Rider</th><th>Vehicle</th><th>Zone</th><th>Tier</th><th>Speed</th><th>Battery</th>
              </tr>
            </thead>
            <tbody>
              {riderList.map((r) => {
                const rt = runtime[r.id];
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.vehicle}</td>
                    <td>{zones.find((z) => z.id === rt?.lastZoneId)?.name ?? "—"}</td>
                    <td><span className={`tier tier-${rt?.tier ?? "NOMINAL"}`}>{rt?.tier ?? "NOMINAL"}</span></td>
                    <td>{r.speedKph} km/h</td>
                    <td>{r.batteryPct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="two-col">
          <div className="panel">
            <h2>Decision Log (read-only — no approval buttons)</h2>
            <ul className="log-list">
              {decisions.map((d) => (
                <li key={d.id}>
                  <div className="log-head">
                    <span>t={Math.floor(d.ts)}s</span>
                    <span>{riders[d.riderId]?.name ?? d.riderId}</span>
                    <span>{d.tierBefore} → {d.tierAfter}</span>
                    <span>score={d.anomalyScore.toFixed(2)}</span>
                    {d.stage2Confidence !== null && <span>conf={d.stage2Confidence.toFixed(2)}</span>}
                    <span className="badge-source">{d.source}</span>
                  </div>
                  <div className="log-body">{d.rationale}</div>
                </li>
              ))}
              {decisions.length === 0 && <li>No decisions yet — inject an incident to see one.</li>}
            </ul>
          </div>

          <div className="panel">
            <h2>Mock Notifications (simulated — no real service is called)</h2>
            <ul className="log-list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <div className="log-head">
                    <span>t={Math.floor(n.ts)}s</span>
                    <span>{riders[n.riderId]?.name ?? n.riderId}</span>
                    <span className="badge-source">{n.channel}</span>
                  </div>
                  <div className="log-body">{n.payload}</div>
                </li>
              ))}
              {notifications.length === 0 && <li>No notifications yet.</li>}
            </ul>
          </div>
        </section>
      </main>

      <footer>Field Agent Check-In — demo build. All notification channels are mocked; no real SMS, IVR, or emergency-dispatch service is contacted.</footer>
    </>
  );
}
