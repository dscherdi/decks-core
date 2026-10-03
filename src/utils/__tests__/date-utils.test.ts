import { getStudyDaySQL, studyDayKey, studyDayStart } from "../date-utils";

// Local wall-clock times: the study day is a local notion, like the setting.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute);

describe("study days", () => {
  it("before the rollover hour, still counts as the previous day", () => {
    expect(studyDayKey(at(29, 2, 6), 4)).toBe("2026-09-28");
    expect(studyDayStart(at(29, 2, 6), 4)).toEqual(at(28, 4));
  });

  it("from the rollover hour on, counts as the calendar day", () => {
    expect(studyDayKey(at(29, 4), 4)).toBe("2026-09-29");
    expect(studyDayKey(at(29, 23, 59), 4)).toBe("2026-09-29");
    expect(studyDayStart(at(29, 13), 4)).toEqual(at(29, 4));
  });

  it("with a midnight rollover, is the calendar day", () => {
    expect(studyDayKey(at(29, 0, 30), 0)).toBe("2026-09-29");
  });

  it("treats an unusable hour as midnight and clamps the rest", () => {
    expect(studyDayKey(at(29, 2), Number.NaN)).toBe("2026-09-29");
    expect(studyDayKey(at(29, 22), 30)).toBe("2026-09-28");
  });

  it("groups a timestamp column by study day in SQL", () => {
    expect(getStudyDaySQL("due_date", 4)).toBe(
      "DATE(due_date, 'localtime', '-4 hours')"
    );
    expect(getStudyDaySQL("due_date", 0)).toBe("DATE(due_date, 'localtime')");
  });
});
