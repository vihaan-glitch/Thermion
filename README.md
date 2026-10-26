# Roomtemp

School districts decide heat-related early dismissals from the **outdoor** forecast. Individual classrooms are never measured, and a second-floor southwest room with no AC can be far hotter than the outdoor reading the decision rests on.

Roomtemp predicts per-room conditions from building physics, sharpens those predictions with sparse human reports through a per-room Kalman filter, and recommends which classes to move.

- **/dashboard**: outdoor-versus-hottest-room hero, a scrubbable **solar sweep** of every facade, predicted indoor curves with ±2σ bands, per-room learned parameters, and the filter's accept/reject log.
- **/report**: a mobile-first, one-handed form to report a classroom temperature in under ten seconds.
- **/plan**: Hungarian-algorithm room reassignment for a chosen period, with before/after exposure in student-degree-hours and a CSV export.

A **heat-wave scenario** toggle (dashboard and plan) runs the same physics on a clearly labeled synthetic June heat wave, so the model can be explored outside heat season. It is never mixed with live data.

## Setup

Requires Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # vitest: physics, filter, optimizer, NWS client, DB
npm run build      # production build (type-checks)
```

The SQLite database is created at `./data/roomtemp.db` on first request. Migrations run automatically, and the seed adds one school (Morris Hills High School), 16 rooms and 14 classes. **No reports are seeded.**

Environment variables (all optional):

| Variable | Purpose |
|---|---|
| `NWS_USER_AGENT` | User-Agent sent to api.weather.gov. NWS asks for an app name plus contact info; set this in production. |
| `ROOMTEMP_DB` | Path to the SQLite file (default `./data/roomtemp.db`, or `/tmp/roomtemp.db` on Vercel). |

The only external network dependency is `api.weather.gov`. There is no auth.

### Deploying to Vercel

```bash
npx vercel deploy --prod
```

Vercel's filesystem is read-only apart from `/tmp`, so the database lives in `/tmp/roomtemp.db` there. It is **ephemeral per serverless instance**: reports survive while an instance stays warm, but a cold start re-seeds an empty database. That is fine for a demo. A production deployment should mount a persistent volume (any Node host) or point `ROOMTEMP_DB` at durable storage.

## Architecture

```
                         api.weather.gov
                               │  /points → forecastHourly (30-min cache, Result<…>, never throws)
                               ▼
┌──────────────────────── lib/nws.ts ─────────────────────────┐
│ hourly periods (temp, RH, sky cover from NWS sky wording)    │
└───────────────┬──────────────────────────────────────────────┘
                │ logged hourly into weather_hours (past hours stay available)
                ▼
        lib/weather.ts ── live │ stale (logged) │ climatology fallback → banner
                │
                ▼                     PURE MODULES (no I/O, unit-tested)
   ┌────────────────────────────────────────────────────────────────────┐
   │ solar.ts       NOAA solar position → elevation, azimuth           │
   │ irradiance.ts  Kasten-Young AM, Meinel beam, diffuse, cos θ on a   │
   │                vertical window, cloud factor → watts into room     │
   │ thermal.ts     dT/dt = invRC·(T_drive − T) + alpha·Q (Euler, 5 min)│
   │ kalman.ts      EKF on [T, invRC, alpha], χ² gating, ±σ tracks      │
   │ heatindex.ts   NWS Rothfusz + adjustments                          │
   │ thresholds.ts  82 advisory / 88 unusable                           │
   │ hungarian.ts   Kuhn-Munkres O(n³)                                  │
   │ reassign.ts    cost matrix, feasibility, padding, plan             │
   └────────────────────────────────────────────────────────────────────┘
                │                                   ▲
                ▼                                   │
   lib/roomModel.ts  recordReport(): insert report → propagate → update
                │                     → room_state + filter_log (one transaction)
                │    buildForecast(): per-room tracks with ±σ, re-anchored at
                │                     each accepted report
                ▼
   app/dashboard   app/report (server action)   app/plan (+ /plan/export CSV)
                │
                ▼
   SQLite (better-sqlite3): schools, rooms, reports, room_state, classes,
                            weather_hours, filter_log   (PRAGMA user_version migrations)
```

### Data flow for a report

1. `/report` posts to a server action, which validates the input (temp 40–130 °F).
2. The forecast log is refreshed (capped at 2.5 s so a slow NWS never blocks a reporter).
3. In one SQLite transaction: insert the report, load the room's Kalman state (or build a prior), propagate it to the report time through logged weather, run the measurement update with χ² gating, persist `room_state`, and append a `filter_log` row (accepted or rejected, with NIS and the posterior).
4. The reporter immediately sees the heat index, the threshold state, and whether the model accepted the reading.

### Kalman filter

State `x = [T, invRC, alpha]`. The process model is one Euler step of the thermal model. invRC and alpha follow random walks, so the filter learns each room's parameters. The Jacobian is derived analytically in `lib/kalman.ts`:

```
      ⎡ 1 − Δt·k   Δt·(T_d − T)   Δt·Q ⎤
  F = ⎢    0            1           0   ⎥
      ⎣    0            0           1   ⎦
```

A report observes T directly (`H = [1, 0, 0]`). Measurement noise is 1.0 °F (1σ) for teachers and staff and 2.0 °F for students. Reports with normalized innovation squared above χ²₁(0.99) = 6.635 are rejected and logged. A rejected reading is accepted later only if a second report within 12 hours agrees with it; that is treated as evidence the model, not the reporters, is wrong.

In a synthetic study (5 rooms × 6 noise seeds, 20 teacher reports each, 2.5 h apart), the learned invRC landed within 20% of truth in 21 of 30 runs, with a normalized-error RMS of 1.4: the filter is mildly overconfident, as EKFs on bilinear models tend to be. The unit test checks the spec case: a synthetic room converges within 20% of its true invRC after 20 observations, and a single 130 °F garbage report is rejected and leaves the estimate unchanged.

### Optimizer

For a period: rows are the classes meeting then, columns are rooms. `cost = enrollment · max(0, peakHI − 82) + movePenalty·[room ≠ assigned]`. Pairs that break capacity or lab requirements are infeasible. The matrix is padded to square (dummy classes cost 0, dummy rooms are infeasible for real classes) and infeasible pairs are encoded as a large finite cost. If the optimal solution uses one, the page says explicitly that no feasible assignment exists, and why. Exposure is reported as student-degree-hours above 82 °F heat index. An option plans against mean + 1σ instead of the mean.

## LIMITATIONS

Every modeling assumption, stated plainly:

**Thermal model**
- **Lumped single-zone model.** Each room is one well-mixed air node with one time constant. No stratification, no separate wall/slab thermal mass, no zone-to-zone coupling through corridors or shared walls.
- **Default time constants.** Without AC, τ = 1/invRC = **3 h** (invRC = 0.33 /h, prior σ 0.25 /h). With AC, τ ≈ **40 min** toward a **72 °F** setpoint (invRC = 1.5 /h, prior σ 0.6 /h). These are priors that the Kalman filter updates per room.
- **AC modeled as a stronger coupling to a fixed setpoint**, assumed to run continuously. AC rooms ignore outdoor temperature entirely, so an undersized or failed unit only shows up after reports teach the filter.
- **Default solar coupling** alpha = 1.0 × 10⁻³ °F/h per W of sunlight on the glass (from ~2.6 MJ/K effective capacity and SHGC ≈ 0.5, rounded down for blinds), prior σ 6 × 10⁻⁴.
- **No internal gains** from occupants (~100 W per student), lighting, computers or lab equipment. A full room of 30 students adds roughly 3 kW that the model does not see except through the filter's process noise and learned parameters.
- **No infiltration or ventilation term** beyond what invRC absorbs: open windows, fans and door traffic are not modeled explicitly.
- **No roof or wall solar gain.** Top-floor rooms get no extra heat from the roof; only window gain is modeled.
- **Forward Euler at 5-minute steps.** Stable and non-oscillatory for these time constants (Δt·invRC ≤ 0.13), with sub-stepping for stiffer values.
- **Initial condition by periodic spin-up**: the temperature reached after integrating the first 24 h of forcing.

**Solar and sky**
- **Clear-sky beam via the Meinel model** (DNI = I₀ · 0.7^(AM^0.678)) with Kasten-Young air mass. There are no aerosol or water-vapor terms, and the transmittance is the same everywhere.
- **Fixed diffuse fraction**: diffuse horizontal irradiance = 10% of the horizontal beam, and a vertical window sees half of an isotropic sky. No circumsolar or horizon brightening, and **no ground-reflected component**.
- **No shading**: overhangs, trees, adjacent buildings and blinds are not modeled. Window orientation is quantized to 8 compass points.
- **Cloud factor** from Kasten-Czeplak, 1 − 0.75·C^3.4. The NWS hourly product has no numeric sky cover, so C is derived from NWS sky-condition wording ("Mostly Sunny" ≈ 25%, and so on: the midpoint of each NWS okta range). Unknown wording means clear sky.

**Weather**
- Hourly NWS values are linearly interpolated (temperature, RH) or held (sky cover). Past hours use the last forecast logged for that hour, not observations.
- If NWS has never been reached, the app falls back to approximate monthly normals for inland north-central New Jersey, and says so in a banner.

**Humidity and heat index**
- Without a measured humidity, indoor RH is estimated by carrying the outdoor dewpoint indoors (naturally ventilated rooms) or assuming 50% (AC rooms). Heat-index uncertainty is the temperature σ propagated linearly through dHI/dT. RH uncertainty is ignored.
- Thresholds (82 / 88 °F) mirror the proposed New York State classroom temperature standard and are applied to heat index, not dry-bulb temperature.

**Kalman filter**
- Process noise (T: 0.5 °F²/h; invRC and alpha random walks) and measurement noise (teacher/staff 1.0 °F, student 2.0 °F) are tuned assumptions, not fitted from data. Students are trusted less because their readings more often come from phone apps or handhelds held near windows.
- The EKF linearizes a bilinear model and is mildly overconfident (see the synthetic study above). Parameters are clamped positive.
- States older than 3 days are not propagated hour by hour: their learned invRC and alpha seed a fresh prior instead.
- Gating can reject a correct but surprising first report. A second, agreeing report within 12 hours overrides the gate.

**Schedule and optimizer**
- Bell schedule assumed: 8 periods of 45 min from 7:30, with 5-minute passing. Weekends and holidays are not special-cased.
- Each room hosts at most one class per period. Only the classes in the selected period are reassigned. Moves are not coordinated across periods, and there are no travel-distance or teacher-preference terms.
- The cost uses the predicted **peak** heat index during the period, not a time average.

**Rooms created from /report** default to building "Main", 6 m² of windows, capacity 25 and not a lab. Edit them in the database for better predictions.

**Deployment**: on Vercel the SQLite file lives in `/tmp` and is lost on cold starts (see above).

## Project layout

```
app/
  dashboard/page.tsx      hero, solar sweep, predictions, rooms, filter log
  report/                 page, client form, server action
  plan/                   page + export/route.ts (CSV)
components/               SolarSweep, PredictionChart, OutdoorChart, UI bits
lib/
  nws.ts heatindex.ts thresholds.ts humidity.ts
  solar.ts irradiance.ts thermal.ts kalman.ts
  hungarian.ts reassign.ts schedule.ts scenario.ts
  db.ts repo.ts weather.ts weatherSeries.ts roomModel.ts
  dashboard.ts planService.ts prediction.ts validate.ts time.ts types.ts
tests/                    vitest suites for every module above
```
