# Data notice

The files under `data/obs/` are **processed** station observations: daily values aggregated from
each source (BC: median of hourly readings per PST day), converted to metric units (cm, mm),
plausibility-filtered (negative sensor offsets clamped to 0, impossible values dropped) and
re-gridded to one value per calendar day. They are not the original records; use the sources
below for authoritative data.

| Stations | Source | Licence / terms | Required notice |
|---|---|---|---|
| Morse Lake, Corral Pass, Cayuse Pass | USDA NRCS National Water and Climate Center (SNOTEL) | US federal government data | — |
| Whistler Roundhouse, Callaghan Valley | Environment and Climate Change Canada, MSC GeoMet | [ECCC Data Servers End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/) | Data Source: Environment and Climate Change Canada |
| Callaghan Creek (3A20P), Squamish River Upper (3A25P) | BC River Forecast Centre, Automated Snow Weather Stations | [Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc) | Contains information licensed under the Open Government Licence – British Columbia |
| Lac des Vaux (ATT2), Combatzeline (NEN3) | WSL Institute for Snow and Avalanche Research SLF, IMIS network | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | WSL Institute for Snow and Avalanche Research SLF, [www.slf.ch](https://www.slf.ch) |
| Fionnay (FIO) | MeteoSwiss Open Government Data | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Source: MeteoSwiss |

Forecast data shown on the site is fetched live by the browser from [Open-Meteo](https://open-meteo.com/)
(CC BY 4.0) and is not stored here.

The MIT licence in `LICENSE` covers the PowderWatch source code only, not this data.
