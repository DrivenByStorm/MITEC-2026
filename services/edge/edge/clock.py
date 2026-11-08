"""Site time for the construction twin, with a speed dial.

Construction runs at the plan's real rates, inside a work shift (07:00 to 07:00 + shiftMinutes,
10 hours by default). Nights are skipped: when a shift ends the clock jumps to the next morning.
Day 1 starts at 07:00 the morning construction is approved.

Times are sent to the UI as UTC epoch ms on a fixed calendar starting 2026-11-09, and the UI
formats them in UTC, so 07:00 on screen is 07:00 on site wherever the browser is.
"""

from __future__ import annotations

import calendar

DAY_S = 86400
BASE_MS = calendar.timegm((2026, 11, 9, 0, 0, 0)) * 1000  # midnight before Day 1, a Monday

SPEEDS = (1, 10, 60, 300, 900)  # construction dial: 900x is 15 site minutes per second
SURVEY_SPEEDS = (1, 2, 5, 10, 20)
TURBO = 3600  # "skip to end of shift": one site hour per second
PACKETS_MAX_SPEED = 2  # above this, packets fly too fast to animate


class SiteClock:
    def __init__(self, shift_minutes: float = 600, start_hour: float = 7):
        self.shift_start = start_hour * 3600
        self.shift_len = shift_minutes * 60
        self.t = self.shift_start  # seconds since midnight before Day 1
        self.speed = 1.0
        self.paused = False
        self.pause_at_day_end = False
        self.turbo_until: float | None = None  # site seconds; set by "skip to end of shift"
        self._paused_before_turbo = False

    # ---------- reading ----------

    @property
    def day(self) -> int:
        return int(self.t // DAY_S) + 1

    @property
    def time_of_day(self) -> float:
        return self.t % DAY_S

    @property
    def shift_end(self) -> float:
        return self.shift_start + self.shift_len

    def on_shift(self) -> bool:
        return self.shift_start <= self.time_of_day < self.shift_end

    def ms(self) -> int:
        return BASE_MS + int(self.t * 1000)

    def ms_at(self, day: int, seconds: float) -> int:
        return BASE_MS + int(((day - 1) * DAY_S + seconds) * 1000)

    def left_in_shift(self) -> float:
        return max(0.0, self.shift_end - self.time_of_day)

    def next_shift_start(self) -> float:
        tod = self.time_of_day
        base = self.t - tod
        return base + self.shift_start if tod < self.shift_start else base + DAY_S + self.shift_start

    @staticmethod
    def hhmm(seconds: float) -> str:
        s = int(seconds) % DAY_S
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"

    def effective_speed(self) -> float:
        if self.turbo_until is not None:
            return TURBO
        return 0.0 if self.paused else self.speed

    def view(self) -> dict:
        return {
            "day": self.day,
            "time": self.hhmm(self.time_of_day),
            "ms": self.ms(),
            "speed": self.speed,
            "effectiveSpeed": self.effective_speed(),
            "paused": self.paused,
            "onShift": self.on_shift(),
            "shiftStart": self.hhmm(self.shift_start),
            "shiftEnd": self.hhmm(self.shift_end),
            "shiftLeftMin": round(self.left_in_shift() / 60),
            "pauseAtDayEnd": self.pause_at_day_end,
            "skipping": self.turbo_until is not None,
            "speeds": list(SPEEDS),
            "surveySpeeds": list(SURVEY_SPEEDS),
            "packetsMaxSpeed": PACKETS_MAX_SPEED,
        }

    # ---------- controls ----------

    def set_speed(self, x: float) -> str:
        self.speed = max(0.25, min(float(max(SPEEDS)), float(x)))
        return f"Simulation speed {self.speed:g}×."

    def set_paused(self, paused: bool) -> str:
        self.paused = paused
        return "Paused." if paused else "Running."

    def skip_to_shift_end(self) -> None:
        self._paused_before_turbo = self.paused
        self.turbo_until = self.t + self.left_in_shift()

    def end_turbo(self) -> None:
        if self.turbo_until is not None:
            self.turbo_until = None
            self.paused = self._paused_before_turbo
