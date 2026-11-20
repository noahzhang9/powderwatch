# Data notice

The files under `data/obs/` are **processed** station observations (except `snodas-*.json`, which are model output; see below): daily values aggregated from
each source (BC: median of hourly readings per PST day), converted to metric units (cm, mm),
plausibility-filtered (negative sensor offsets clamped to 0, impossible values dropped) and
re-gridded to one value per calendar day. They are not the original records; use the sources
below for authoritative data.

| Stations | Source | Licence / terms | Required notice |
|---|---|---|---|
| Morse Lake, Corral Pass, Cayuse Pass, Olallie Meadows, Tinkham Creek, Stampede Pass, Stevens Pass, Fish Lake | USDA NRCS National Water and Climate Center (SNOTEL) | US federal government data | — |
| Whistler Roundhouse, Callaghan Valley | Environment and Climate Change Canada, MSC GeoMet | [ECCC Data Servers End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/) | Data Source: Environment and Climate Change Canada |
| Callaghan Creek (3A20P), Squamish River Upper (3A25P) | BC River Forecast Centre, Automated Snow Weather Stations | [Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc) | Contains information licensed under the Open Government Licence – British Columbia |
| Lac des Vaux (ATT2), Combatzeline (NEN3) | WSL Institute for Snow and Avalanche Research SLF, IMIS network | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | WSL Institute for Snow and Avalanche Research SLF, [www.slf.ch](https://www.slf.ch) |
| Fionnay (FIO) | MeteoSwiss Open Government Data | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Source: MeteoSwiss |

## Modelled snowpack: SNODAS

The `data/obs/snodas-*.json` files are **processed model output**, not observations. They hold NOAA
NOHRSC SNODAS snow depth (product 1036) and snow water equivalent (product 1034), the model state
at 06:00 UTC each day, read from the single 1 km cell of NSIDC's masked daily grid that contains each
band of Crystal Mountain, Snoqualmie / Alpental and Stevens Pass. The stored integers are converted
from millimetres to cm (depth) and mm (SWE); no-data and clipped cells, and values beyond 1,500 cm
depth or 5,000 mm SWE, are dropped. History covers October–June of each season from 2004–05 once the
backfill has run; the scheduled job adds each new day.

| Data | Source | Licence / terms | Required citation |
|---|---|---|---|
| SNODAS snow depth and SWE at 9 resort-band cells | [NOAA NOHRSC SNODAS, via NSIDC (G02158)](https://nsidc.org/data/g02158/versions/1) | US government data; NSIDC requires a citation as a condition of use | National Operational Hydrologic Remote Sensing Center. (2004). Snow Data Assimilation System (SNODAS) Data Products at NSIDC. (G02158, Version 1). [Data Set]. Boulder, Colorado USA. National Snow and Ice Data Center. https://doi.org/10.7265/N5TB14TC. Subset: masked daily snow depth (1036) and SWE (1034) at single 1 km cells. Accessed daily from 2026-11-20. |

Forecast data shown on the site comes from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). The
files under `data/fc/` (except `wpc-*.json`, below) are unmodified copies of Open-Meteo API responses, refreshed every 4 hours;
the browser fetches anything not in them from Open-Meteo directly.

The "Compare with official guidance" benchmarks on the Storm tracker (US resorts) are US government data:

| Benchmark | Source | Licence / terms | Notice |
|---|---|---|---|
| NOAA National Blend of Models (NBM): NBM's own snowfall | NOAA/NWS, through Open-Meteo | US federal government data; Open-Meteo CC BY 4.0 | Open-Meteo |
| Probabilistic winter precipitation outlook, Day 1–3 chances of ≥ 4, 8 and 12 in | [NOAA/NWS Weather Prediction Center](https://www.wpc.ncep.noaa.gov/wwd/winter_wx.shtml), [ArcGIS service](https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer) | US federal government data | Source: NOAA/NWS Weather Prediction Center |

The `data/fc/wpc-*.json` file is **processed**: the scheduled job queries WPC's polygons at each US
resort's mid-mountain point and keeps only the probability category there (under 10%, 10–39%,
40–69%, 70% or more) and each day's valid period and issue time. Use WPC for the authoritative product.

The MIT licence in `LICENSE` covers the PowderWatch source code only, not this data.
