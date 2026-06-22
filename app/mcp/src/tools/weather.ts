import type { ToolModule } from './types.js';

// Weather via Open-Meteo (https://open-meteo.com). Free, no API key,
// generous rate limit (~10k requests/day for non-commercial). Single
// tool that does geocoding + forecast internally so the LLM doesn't
// have to chain two calls for the common "weather in <city>" question.

const ENABLED = process.env.WEATHER_TOOL_ENABLED === '1';

type GeocodeResult = {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
  admin1?: string;
  timezone?: string;
};

type GeocodeResponse = { results?: GeocodeResult[] };

const definitions: ToolModule['definitions'] = [
  {
    name: 'get_weather',
    description:
      "Get current conditions + 3-day forecast for a city. Returns temperature (°C), humidity, wind (km/h), precipitation, and WMO weather codes. " +
      'Use when the user asks about weather, what to wear, or anything weather-adjacent. ' +
      'Resolve the location yourself via the `location` arg (city name; optionally "City, Country" for disambiguation) — the tool handles geocoding internally.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name. Add country for disambiguation (e.g. "Paris, France" vs "Paris, Texas").',
        },
      },
      required: ['location'],
    },
  },
];

const handlers: ToolModule['handlers'] = {
  get_weather: async (input) => {
    const location = String(input.location ?? '').trim();
    if (!location) throw new Error('location is required');

    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) {
      throw new Error(`open-meteo geocoding ${geoRes.status}`);
    }
    const geoData = (await geoRes.json()) as GeocodeResponse;
    if (!geoData.results || geoData.results.length === 0) {
      return JSON.stringify({ error: `Location not found: ${location}` });
    }
    const loc = geoData.results[0];
    const tz = loc.timezone ?? 'UTC';

    const fcParams = new URLSearchParams({
      latitude: String(loc.latitude),
      longitude: String(loc.longitude),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,precipitation',
      daily:
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset,uv_index_max',
      timezone: tz,
      forecast_days: '3',
    });
    const fcRes = await fetch(`https://api.open-meteo.com/v1/forecast?${fcParams}`);
    if (!fcRes.ok) {
      throw new Error(`open-meteo forecast ${fcRes.status}`);
    }
    const fc = await fcRes.json();

    return JSON.stringify({
      location: {
        name: loc.name,
        admin1: loc.admin1,
        country: loc.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timezone: tz,
      },
      weather: fc,
      legend: {
        weather_code:
          '0=clear, 1-3=partly cloudy, 45-48=fog, 51-67=drizzle/rain, 71-77=snow, 80-82=showers, 95-99=thunderstorm (WMO convention)',
        units: 'temperatures in °C, wind in km/h, precipitation in mm',
      },
    });
  },
};

export const weatherTools: ToolModule = {
  name: 'weather',
  enabled: () => ENABLED,
  definitions,
  handlers,
  // Read-only, free, no rate-limit concern at family scale.
  autoApproved: ['get_weather'],
};
