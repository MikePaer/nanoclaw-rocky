---
name: flight-status
description: Look up real-time flight status, schedules, routes, airlines, airports, and aircraft via AviationStack. Use when the user asks about a specific flight, arrivals/departures at an airport, or airline/route info.
---

# /flight-status — Flight Data via AviationStack

**Base URL:** `https://api.aviationstack.com/v1`

The API key is available as `$AVIATION_STACK_API_KEY` in the container environment. Append it as `?access_key=$AVIATION_STACK_API_KEY` to every request.

## Endpoints

| Endpoint | Purpose | Common params |
|----------|---------|---------------|
| `/flights` | Real-time flights | `flight_iata`, `flight_icao`, `airline_iata`, `dep_iata`, `arr_iata`, `flight_status` |
| `/flightsFuture` | Scheduled future flights | `iataCode`, `type=departure\|arrival`, `date=YYYY-MM-DD` |
| `/routes` | Airline routes | `airline_iata`, `flight_number`, `dep_iata`, `arr_iata` |
| `/airlines` | Airline info | `airline_name`, `iata_code` |
| `/airports` | Airport info | `search`, `iata_code` |
| `/aircraft` | Aircraft info | `iata_code`, `icao_code` |

## How to call

```bash
curl -s "https://api.aviationstack.com/v1/flights?access_key=$AVIATION_STACK_API_KEY&flight_iata=AS548"
```

## Examples

**Specific flight:**
```bash
curl -s "https://api.aviationstack.com/v1/flights?access_key=$AVIATION_STACK_API_KEY&flight_iata=AA100"
```

**Departures from SFO right now:**
```bash
curl -s "https://api.aviationstack.com/v1/flights?access_key=$AVIATION_STACK_API_KEY&dep_iata=SFO&flight_status=active"
```

**Future departures from JFK on a date:**
```bash
curl -s "https://api.aviationstack.com/v1/flightsFuture?access_key=$AVIATION_STACK_API_KEY&iataCode=JFK&type=departure&date=2026-05-01"
```

## Response shape

```json
{
  "pagination": { "limit": 100, "offset": 0, "count": N, "total": N },
  "data": [ ... ]
}
```

Each flight has `flight_status`, `departure.{airport,scheduled,estimated,actual,delay}`, `arrival.{...}`, `airline.{name,iata}`, `flight.{number,iata}`, `aircraft`, `live.{...}` (when airborne).

## Formatting replies

Pull only the fields the user asked about:

> **AS548** · Alaska Airlines · SEA → SFO  
> Scheduled 14:20 · Actual 14:31 (+11m) · Status: landed  
> Gate: C9

Don't dump raw JSON at the user.

## Errors

- `401` → `AVIATION_STACK_API_KEY` not set or wrong. Check `.env` on the host.
- Empty `data` array → flight not found or outside retention window. Verify the IATA code.
- `429` → monthly quota exceeded (free tier: 100 requests/month).
