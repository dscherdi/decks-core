import type { IDatabaseService } from "../../database/DatabaseService.interface";
import type { Statistics } from "../../database/types";
import { DEFAULT_SETTINGS } from "../../settings";
import { StatisticsService } from "../StatisticsService";

// The forecast as getForecastDueCards keys it: by study day, overdue cards in today's.
const statistics = {
  forecast: [
    { date: "2026-01-14", dueCount: 2, count: 2 },
    { date: "2026-01-15", dueCount: 1, count: 1 },
    { date: "2026-01-16", dueCount: 4, count: 4 },
  ],
} as Statistics;

function serviceWith(nextDayStartsAt: number): StatisticsService {
  // The due lookups read only the forecast they are given, never the database.
  const db = {} as IDatabaseService;
  return new StatisticsService(db, {
    ...DEFAULT_SETTINGS,
    review: { ...DEFAULT_SETTINGS.review, nextDayStartsAt },
  });
}

describe("forecast days from today", () => {
  const service = serviceWith(4);

  it.each([
    // Before the 04:00 rollover it is still the 14th's study day.
    ["00:30", new Date(2026, 0, 15, 0, 30), 2, 1],
    ["03:59", new Date(2026, 0, 15, 3, 59), 2, 1],
    ["04:00", new Date(2026, 0, 15, 4, 0), 1, 4],
    ["12:00", new Date(2026, 0, 15, 12, 0), 1, 4],
  ])("at %s read the study day's bucket and the next one", (_time, now, today, tomorrow) => {
    expect(service.getDueToday(statistics, now)).toBe(today);
    expect(service.getDueTomorrow(statistics, now)).toBe(tomorrow);
    expect(service.calculateForecastStats(statistics, [], 30, now).dueTomorrow).toBe(tomorrow);
  });

  it.each([
    ["00:30", new Date(2026, 0, 15, 0, 30), [0, 1, 2]],
    ["03:59", new Date(2026, 0, 15, 3, 59), [0, 1, 2]],
    ["04:00", new Date(2026, 0, 15, 4, 0), [-1, 0, 1]],
    ["12:00", new Date(2026, 0, 15, 12, 0), [-1, 0, 1]],
  ])("at %s count forecast days from today's study day", (_time, now, offsets) => {
    const days = statistics.forecast.map((day) => service.forecastDayOffset(day.date, now));
    expect(days).toEqual(offsets);
  });

  it("follow the calendar day when the day rolls over at midnight", () => {
    const midnight = serviceWith(0);
    const now = new Date(2026, 0, 15, 0, 30);
    expect(midnight.getDueToday(statistics, now)).toBe(1);
    expect(midnight.getDueTomorrow(statistics, now)).toBe(4);
  });
});
