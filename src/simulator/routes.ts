import type { Rider, RouteSegment } from "../types";
import { ZONES } from "./zones";

// Fixed grid positions per zone (0..100), used only for the dashboard's synthetic map.
export const ZONE_POSITIONS: Record<string, { x: number; y: number }> = {
  "open-road": { x: 15, y: 20 },
  "flyover-7": { x: 45, y: 15 },
  "tunnel-nh4": { x: 70, y: 30 },
  "market-basement": { x: 55, y: 60 },
  "rural-stretch-9": { x: 85, y: 75 },
  "unmapped-detour-1": { x: 25, y: 80 },
};

const ROUTE_TEMPLATES: RouteSegment[][] = [
  [
    { zoneId: "open-road", travelTimeSec: 40 },
    { zoneId: "flyover-7", travelTimeSec: 25 },
    { zoneId: "open-road", travelTimeSec: 40 },
  ],
  [
    { zoneId: "open-road", travelTimeSec: 30 },
    { zoneId: "tunnel-nh4", travelTimeSec: 35 },
    { zoneId: "market-basement", travelTimeSec: 20 },
  ],
  [
    { zoneId: "open-road", travelTimeSec: 50 },
    { zoneId: "rural-stretch-9", travelTimeSec: 60 },
    { zoneId: "open-road", travelTimeSec: 50 },
  ],
  [
    { zoneId: "market-basement", travelTimeSec: 15 },
    { zoneId: "open-road", travelTimeSec: 35 },
    { zoneId: "flyover-7", travelTimeSec: 25 },
  ],
  [
    { zoneId: "open-road", travelTimeSec: 30 },
    { zoneId: "unmapped-detour-1", travelTimeSec: 40 },
    { zoneId: "open-road", travelTimeSec: 30 },
  ],
];

const RIDER_NAMES = [
  "Arjun", "Priya", "Karan", "Meera", "Sanjay",
  "Divya", "Rohit", "Anjali", "Vikram", "Neha",
];

const VEHICLES = ["Scooter", "Bike", "E-cycle"];

export function generateRiders(count: number = 10): Rider[] {
  const riders: Rider[] = [];
  for (let i = 0; i < count; i++) {
    const route = ROUTE_TEMPLATES[i % ROUTE_TEMPLATES.length];
    const startPos = ZONE_POSITIONS[route[0].zoneId];
    riders.push({
      id: `rider-${i + 1}`,
      name: RIDER_NAMES[i % RIDER_NAMES.length],
      vehicle: VEHICLES[i % VEHICLES.length],
      route,
      segmentIndex: 0,
      x: startPos.x,
      y: startPos.y,
      speedKph: 28 + Math.round(Math.random() * 10),
      batteryPct: 60 + Math.round(Math.random() * 40),
    });
  }
  return riders;
}
