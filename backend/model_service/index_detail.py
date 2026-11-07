# Vendored verbatim from the canonical v3 service (~/workspace/lupus_repo/backend/model_service/index_detail.py).
# Do not edit here; change the canonical file and re-vendor.
"""
Lupus Cortex — Detailed Index-wise Analysis Engine.

For each of the 9 indices, generates:
- Index score, label
- Component scores + labels within that index
- Warnings (naming specific components)
- Detailed improvement guidelines (where + how)
- Organized intervention plans (individual/community/industrial/government)
- Detailed real-world examples (context, relatability, solution, timeline, actionable keys)
- Natural predictions with reasons (naming specific indices/components)

HWI: full score breakdown with component contributions.
"""
from __future__ import annotations


# Detailed intervention knowledge base: index -> detailed guidance
INDEX_GUIDANCE = {
    "AQHI": {
        "improve_where": "Emission sources: brick kilns, traffic corridors, construction dust, biomass burning.",
        "improve_how": [
            "Enforce Euro 4/BS-VI vehicle emission standards on high-traffic corridors; deploy continuous ambient monitoring at 5+ stations.",
            "Mandate zigzag technology conversion for brick kilns within 50 km (cuts PM by ~40%).",
            "Water-spray and wind-barrier protocols at construction sites larger than 1 acre.",
            "Subsidize LPG/electric cooking to replace biomass in peri-urban households.",
        ],
        "examples": [
            {
                "city": "Delhi, India",
                "problem_context": "Winter PM2.5 routinely exceeded 300 µg/m³ (20x WHO guideline), driven by crop burning, vehicles, and kilns — directly comparable to Dhaka's dry-season spikes.",
                "relatability": "Same Indo-Gangetic plain meteorology: winter inversions trap pollutants; same source mix (kilns, traffic, biomass).",
                "solution": "Graded Response Action Plan (GRAP): staged restrictions triggered by AQI bands — odd-even traffic, kiln shutdowns, construction bans.",
                "timeline": "GRAP notified 2017; Stage III/IV invoked each winter since. Measurable dip in peak-season PM2.5 within 3 winters.",
                "key_actions": [
                    "Define 4 AQI trigger bands with pre-agreed actions (no ad-hoc decisions).",
                    "Publish daily AQI with source apportionment so the public sees which source is spiking.",
                    "Enforce kiln shutdowns FIRST (largest point sources) before restricting citizens.",
                ],
            },
            {
                "city": "Beijing, China",
                "problem_context": "2013 'Airpocalypse': PM2.5 hit 900 µg/m³; coal heating + industry + vehicles.",
                "relatability": "Demonstrates that a megacity CAN reverse severe pollution with sustained policy — relevant to Dhaka's trajectory.",
                "solution": "Air Pollution Prevention and Control Action Plan: coal-to-gas conversion, factory closures/relocation, vehicle quotas, regional coordination.",
                "timeline": "2013–2017 (5-year plan); PM2.5 fell ~35% by 2017, continued declining after.",
                "key_actions": [
                    "Set a binding 5-year PM2.5 reduction target with annual milestones.",
                    "Convert coal heating to gas/electric in one heating season (biggest single lever).",
                    "Coordinate across the airshed region — pollution ignores city boundaries.",
                ],
            },
        ],
    },
    "UHVI": {
        "improve_where": "Dense built-up zones with low vegetation, tin-roof settlements, asphalt corridors.",
        "improve_how": [
            "Mandate cool-roof coatings (albedo >0.6) on new commercial buildings; retrofit 20% of public buildings per year.",
            "Plant 100,000 street trees along 50 km of priority corridors (shade + evapotranspiration).",
            "Create pocket parks (min 0.5 acre) within 500 m of every high-density ward.",
            "Establish heat-action thresholds: public cooling centers open when air temp exceeds 38°C for 2+ days.",
        ],
        "examples": [
            {
                "city": "Ahmedabad, India",
                "problem_context": "2010 heatwave killed 1,300+; slum dwellers and outdoor workers most exposed — mirrors Dhaka's vulnerable groups.",
                "relatability": "South Asian megacity, similar housing stock (tin roofs), similar vulnerable populations.",
                "solution": "South Asia's first Heat Action Plan: early warnings, cool roofs, drinking water stations, hospital preparedness.",
                "timeline": "Launched 2013; heat-related deaths fell significantly in subsequent heatwaves.",
                "key_actions": [
                    "Issue 7-day heat forecasts with color-coded alerts (yellow/orange/red).",
                    "Distribute free cool-roof paint in slums (low cost, immediate indoor temp drop of 2-5°C).",
                    "Train hospitals on heat-illness triage before summer, not during.",
                ],
            },
            {
                "city": "Singapore",
                "problem_context": "Tropical heat + dense urbanization; needed to stay livable without excessive AC energy.",
                "relatability": "Shows long-term planning works: greenery as infrastructure, not decoration.",
                "solution": "Singapore Green Plan 2030: 1 million trees, park connectors, building greenery mandates.",
                "timeline": "Multi-decade; Green Plan 2030 sets binding targets for 2030.",
                "key_actions": [
                    "Mandate sky-rise greenery on new developments (replaces lost ground greenery).",
                    "Connect parks with shaded walkways so greenery is a network, not islands.",
                    "Measure land-surface temperature annually to track cooling impact.",
                ],
            },
        ],
    },
    "GEAI": {
        "improve_where": "Wards with <10% green cover; industrial zones; new developments.",
        "improve_how": [
            "Require 15% green plot ratio for developments over 1 acre (enforceable via building permits).",
            "Convert 50 vacant lots to community gardens per year (low cost, high social return).",
            "Protect existing mature trees with a tree-cutting permit system and replacement ratio of 1:5.",
            "Map green-space access gaps: every resident within 800 m walk of a public green space.",
        ],
        "examples": [
            {
                "city": "Bogotá, Colombia",
                "problem_context": "Rapid growth consumed green areas; low-income districts had almost no parks.",
                "relatability": "Demonstrates equity-focused greening: prioritize underserved wards first.",
                "solution": "Ciclovía + park system expansion; TransMilenio corridors paired with greenways.",
                "timeline": "1998–2010s; park access dramatically expanded.",
                "key_actions": [
                    "Map green access by income quintile; build first where the gap is largest.",
                    "Pair transport corridors with linear parks (dual-use infrastructure).",
                    "Use temporary street closures (Ciclovía model) to demonstrate demand for green public space.",
                ],
            },
        ],
    },
    "WSII": {
        "improve_where": "Flood-prone lowlands, areas with poor drainage, groundwater-depleted zones.",
        "improve_how": [
            "Desilt and maintain 100 km of drainage canals before each monsoon (April deadline).",
            "Install 500 rainwater harvesting systems in public buildings (reduces runoff + supplements supply).",
            "Enforce no-construction zones in delineated floodplains; relocate critical assets.",
            "Deploy community flood early-warning via SMS at 48h/24h/6h lead times.",
        ],
        "examples": [
            {
                "city": "Dhaka, Bangladesh (FFWC)",
                "problem_context": "Annual monsoon floods displace thousands; drainage overwhelmed by solid waste and encroachment.",
                "relatability": "Local system — directly applicable; shows what already works in this context.",
                "solution": "Flood Forecasting and Warning Centre (FFWC): 5-day deterministic + 10-day probabilistic forecasts.",
                "timeline": "Operational since 1972; upgraded to 5-day forecasts in 2010s.",
                "key_actions": [
                    "Extend warning lead time from 3 to 5 days (proven to cut losses).",
                    "Clear drainage choke points identified by satellite + citizen reports.",
                    "Pre-position relief at union level before warnings, not after.",
                ],
            },
            {
                "city": "Rotterdam, Netherlands",
                "problem_context": "Below-sea-level city; needed flood safety without walling off the waterfront.",
                "relatability": "Shows 'living with water' philosophy vs 'fighting water' — relevant for delta cities.",
                "solution": "Room for the River + water plazas: public squares that become retention basins in storms.",
                "timeline": "2006–2018 for Room for the River; water plazas from 2013.",
                "key_actions": [
                    "Design public spaces to flood safely (dual-use: plaza normally, basin in storms).",
                    "Give rivers room: widen floodplains instead of raising dikes endlessly.",
                    "Involve residents in water-plaza design so they value the infrastructure.",
                ],
            },
        ],
    },
    "TAI": {
        "improve_where": "Peri-urban areas with no formal transit; congested arterial roads.",
        "improve_how": [
            "Launch 3 BRT-lite corridors on the busiest routes (dedicated lanes, pre-board ticketing).",
            "Formalize paratransit (tempo/rickshaw) with designated stops and route numbering.",
            "Build 50 km of protected cycle lanes connecting residential zones to transit hubs.",
            "Implement off-peak freight delivery windows to free road capacity.",
        ],
        "examples": [
            {
                "city": "Bogotá, Colombia (TransMilenio)",
                "problem_context": "Gridlock, informal buses, 2+ hour commutes for the poor — similar to Dhaka's traffic crisis.",
                "relatability": "Proves BRT works in developing-country megacities at 1/10th the cost of metro.",
                "solution": "TransMilenio BRT: dedicated lanes, enclosed stations, feeder buses, integrated fares.",
                "timeline": "Phase 1 opened 2000 (after ~3 years construction); expanded in phases.",
                "key_actions": [
                    "Start with ONE corridor done well rather than a city-wide plan done poorly.",
                    "Integrate feeders: trunk BRT useless without last-mile connections.",
                    "Price it for the poor: the system must serve those who need it most.",
                ],
            },
        ],
    },
    "HAI": {
        "improve_where": "Wards >5 km from a hospital; slums with no primary care.",
        "improve_how": [
            "Deploy 20 mobile health clinics rotating through underserved wards weekly.",
            "Map hospital catchments: no resident should be >30 min from emergency care.",
            "Train 500 community health workers (Shasthya Shebika model) for doorstep screening.",
            "Digitize referral chains so primary clinics can book hospital slots directly.",
        ],
        "examples": [
            {
                "city": "Rwanda",
                "problem_context": "Post-conflict, minimal health infrastructure, high maternal mortality.",
                "relatability": "Shows community health workers + mobile tech can leapfrog infrastructure gaps.",
                "solution": "Community health worker network (45,000+) + drone blood delivery (Zipline) + mutuelle insurance.",
                "timeline": "2000s–2010s; maternal mortality fell ~70%.",
                "key_actions": [
                    "Put a trained health worker in every village (paid, supervised, supplied).",
                    "Use drones/mobile for the last-mile supply chain where roads fail.",
                    "Make insurance enrollment automatic at community level.",
                ],
            },
        ],
    },
    "CRI": {
        "improve_where": "Multi-hazard zones: flood + heat + cyclone overlap areas.",
        "improve_how": [
            "Complete ward-level multi-hazard maps (flood + heat + cyclone) by next monsoon.",
            "Retrofit 100 schools as cyclone/flood shelters (dual-use, always maintained).",
            "Establish ward disaster funds with pre-approved disbursement triggers.",
            "Run annual city-wide drills before monsoon season (April).",
        ],
        "examples": [
            {
                "city": "Bangladesh Cyclone Preparedness Programme",
                "problem_context": "1970 Bhola cyclone killed 300,000+; 1991 killed 138,000. Recurring Bay of Bengal cyclones.",
                "relatability": "Bangladesh's own success story — the global gold standard for cyclone preparedness.",
                "solution": "CPP volunteers (76,000+), cyclone shelters, early warning via radio/flags/megaphones, evacuation drills.",
                "timeline": "1972–present; deaths per cyclone fell from hundreds of thousands to hundreds.",
                "key_actions": [
                    "Maintain a standing volunteer network (not ad-hoc mobilization).",
                    "Build shelters within 2 km of every coastal household.",
                    "Practice evacuation BEFORE the storm — drills save more lives than warnings alone.",
                ],
            },
        ],
    },
    "SCI": {
        "improve_where": "High-density low-income wards; areas with poor service access.",
        "improve_how": [
            "Target social safety nets by ward vulnerability score (not just income).",
            "Upgrade 10 slums per year with water, sanitation, drainage, and paved lanes.",
            "Create ward-level vulnerability dashboards updated annually.",
            "Ensure 100% birth registration and NID coverage in vulnerable wards (gateway to services).",
        ],
        "examples": [
            {
                "city": "Medellín, Colombia",
                "problem_context": "Hillside comunas: violence, isolation, no services — among the world's most dangerous.",
                "relatability": "Shows infrastructure + social investment can transform 'no-go' zones.",
                "solution": "Metrocable (gondolas) + library-parks + public escalators in Comuna 13; 'social urbanism'.",
                "timeline": "2004–2015; homicide rate fell ~80%.",
                "key_actions": [
                    "Build the BEST public architecture in the POOREST areas (signals state presence).",
                    "Connect isolated hillsides with cable cars (cheap, fast, transformative).",
                    "Pair every infrastructure project with social programs (youth, culture, jobs).",
                ],
            },
        ],
    },
    "DRI": {
        "improve_where": "Coastal and flood-prone wards; critical facilities (hospitals, schools).",
        "improve_how": [
            "Audit all hospitals/schools for flood/cyclone resilience; retrofit priority list by June.",
            "Stockpile 72-hour emergency supplies at 50 ward centers (water, food, medicine, power).",
            "Sign MOUs with private sector for emergency logistics (trucks, warehouses, fuel).",
            "Publish an annual readiness scorecard per ward (creates accountability).",
        ],
        "examples": [
            {
                "city": "Japan (Tohoku lessons)",
                "problem_context": "2011 earthquake+tsunami: 18,000 deaths despite advanced systems — exposed last-mile gaps.",
                "relatability": "Even rich countries fail at readiness; the lesson is continuous drilling, not technology alone.",
                "solution": "Revised hazard maps, raised seawalls where justified, but MAINLY: evacuation drills, community bosai (disaster-prevention) groups.",
                "timeline": "2011–present; ongoing annual national drills (Sept 1).",
                "key_actions": [
                    "Drill evacuation annually — muscle memory beats pamphlets.",
                    "Map 'beyond-design-basis' scenarios (what if the wall fails?).",
                    "Empower neighborhood bosai groups with equipment and training.",
                ],
            },
        ],
    },
}


def build_index_detail(ikey, idef, comps, lat, lon):
    """Build the full detailed analysis for one index."""
    # Component details for this index
    comp_details = []
    for cid in idef["components"]:
        c = comps.get(cid, {})
        comp_details.append({
            "id": cid,
            "name": c.get("name", cid),
            "value": c.get("value"),
            "unit": c.get("unit"),
            "score": c.get("score"),
            "label": c.get("label"),
            "availability": c.get("availability", "unavailable"),
            "note": c.get("note"),
        })

    # Warnings naming specific components
    warnings = []
    for cd in comp_details:
        if cd["label"] in ("Poor", "Harmful") and cd["availability"] in ("available", "derived", "proxy"):
            warnings.append({
                "severity": "high" if cd["label"] == "Harmful" else "medium",
                "component_id": cd["id"],
                "component_name": cd["name"],
                "message": f"{cd['name']} ({cd['id']}) scored {cd['score']}/100 ({cd['label']}). "
                           f"Value: {cd['value']} {cd['unit']}. "
                           f"This drags the {idef['name']} down and needs targeted action.",
            })

    guidance = INDEX_GUIDANCE.get(ikey, {})
    score = None
    cscores = [c["score"] for c in comp_details if c["score"] is not None]
    if cscores:
        score = round(sum(cscores) / len(cscores), 1)

    # Natural prediction with reasons, naming index and components
    prediction = _build_prediction(ikey, idef, comp_details, score)

    return {
        "key": ikey,
        "name": idef["name"],
        "category": idef.get("category"),
        "description": idef.get("description"),
        "target": idef.get("target"),
        "score": score,
        "label": _label(score),
        "status": _label(score),
        "components": comp_details,
        "warnings": warnings,
        "improve_where": guidance.get("improve_where"),
        "improve_how": guidance.get("improve_how", []),
        "interventions": {
            "individual": _interventions_for(ikey, "individual"),
            "community": _interventions_for(ikey, "community"),
            "industrial": _interventions_for(ikey, "industrial"),
            "government": _interventions_for(ikey, "government"),
        },
        "examples": guidance.get("examples", []),
        "prediction": prediction,
    }


def _label(score):
    if score is None:
        return "Data unavailable"
    if score >= 81: return "Perfect"
    if score >= 61: return "Well managed"
    if score >= 41: return "Needs improvement"
    if score >= 21: return "Poor"
    return "Harmful"


def _build_prediction(ikey, idef, comp_details, score):
    """Natural, detailed prediction naming the index and specific components."""
    worst = [c for c in comp_details if c["label"] in ("Poor", "Harmful")]
    best = [c for c in comp_details if c["label"] in ("Perfect", "Well managed")]

    parts = [f"The {idef['name']} ({ikey}) currently scores {score}/100 ({_label(score)})."]

    if worst:
        w = worst[0]
        parts.append(
            f"The weakest link is {w['name']} ({w['id']}): {w['value']} {w['unit']} "
            f"scores only {w['score']}/100 ({w['label']}). "
            f"If {w['name']} deteriorates by 20% — for example from seasonal spikes or "
            f"unregulated growth — the {ikey} would drop by approximately "
            f"{round((100 - w['score']) * 0.2 / len(comp_details), 1)} points, "
            f"pushing it toward '{_label(score - 10)}' territory. "
            f"Vulnerable groups (children, elderly, outdoor workers) would feel this first."
        )
    if best:
        b = best[0]
        parts.append(
            f"On the positive side, {b['name']} ({b['id']}) at {b['score']}/100 "
            f"is holding the index up. Protecting this gain — through maintenance of "
            f"existing controls — is as important as fixing the weaknesses."
        )

    # Index-specific forward look
    outlooks = {
        "AQHI": "Without intervention, dry-season PM2.5 typically rises 30-50% (Nov-Feb), which would push AQHI toward 'Poor'. With GRAP-style staged controls, peaks can be cut by 15-25%.",
        "UHVI": "Each 1°C rise in summer maximum temperature increases heat-illness risk disproportionately for tin-roof households. Cool-roof programs show 2-5°C indoor reductions within one season.",
        "GEAI": "If green-space loss continues at current urbanization rates, GEAI could fall 5-10 points in 3 years. Each new pocket park in a deficit ward lifts the local score measurably.",
        "WSII": "Monsoon intensification means flood exposure will likely worsen before drainage upgrades catch up. Areas with WSII below 40 face recurring annual losses without intervention.",
        "TAI": "Without BRT or formalized transit, congestion costs grow ~10% yearly. One BRT corridor can cut commute times 30-40% on its route within 2 years of opening.",
        "HAI": "Hospital access gaps compound in emergencies — a ward scoring 'Poor' on HAI will see 2-3x higher preventable mortality in a flood or heatwave.",
        "CRI": "Climate resilience is the slowest to build and fastest to lose. One unmanaged monsoon can erase 3 years of CRI gains in low-lying wards.",
        "SCI": "Social vulnerability amplifies every other risk: a 'Poor' SCI ward experiences the same flood as 2x the human cost of a 'Well managed' ward.",
        "DRI": "Readiness decays without drills. Wards that drill annually maintain scores; those that don't typically drop 5-8 points per year as equipment degrades and volunteers leave.",
    }
    parts.append(outlooks.get(ikey, "Trend depends on sustained intervention in the weakest components."))

    return " ".join(parts)


def _interventions_for(ikey, level):
    """Specific, organized interventions per index and stakeholder level."""
    table = {
        "AQHI": {
            "individual": ["Wear N95 masks on 'Poor' AQI days; limit outdoor exercise 6-10 AM in winter.", "Switch to LPG/electric cooking; service vehicle engines annually."],
            "community": ["Organize car-free Sundays on 3 major roads (pilot, then expand).", "Community monitoring: 10 low-cost sensors per ward, data published openly."],
            "industrial": ["Brick kilns: convert to zigzag technology by next dry season (40% PM cut).", "Construction: mandatory water-spray + barriers; fines for violations."],
            "government": ["Notify GRAP-style staged action plan with 4 AQI trigger bands.", "Deploy 5 continuous monitoring stations; publish daily AQI with source breakdown."],
        },
        "UHVI": {
            "individual": ["Paint roofs white/reflective (2-5°C indoor drop); hydrate before thirst in heatwaves."],
            "community": ["Open 5 cooling centers per heat-prone ward when temp >38°C for 2 days.", "Plant 1,000 street trees per ward per year (resident-maintained)."],
            "industrial": ["Mandate cool roofs (albedo >0.6) on new commercial buildings.", "Shift heavy outdoor labor to 6-10 AM / 4-7 PM in summer."],
            "government": ["Launch Heat Action Plan with 7-day forecasts and color alerts.", "Target: 100,000 trees along 50 km corridors in 3 years."],
        },
        "GEAI": {
            "individual": ["Adopt-a-tree: residents maintain 2 street trees each."],
            "community": ["Convert 5 vacant lots to community gardens per ward per year."],
            "industrial": ["15% green plot ratio for developments over 1 acre (permit condition)."],
            "government": ["Tree-cutting permits with 1:5 replacement ratio; map access gaps by ward."],
        },
        "WSII": {
            "individual": ["Install rainwater harvesting (500L) before monsoon; keep drains near home clear."],
            "community": ["Pre-monsoon drain-cleaning drives (April); community flood wardens per lane."],
            "industrial": ["Zero liquid discharge for riverside factories; effluent monitoring published."],
            "government": ["Desilt 100 km canals by April; 48h/24h/6h SMS flood warnings; no-build floodplain enforcement."],
        },
        "TAI": {
            "individual": ["Shift to cycle for trips <3 km where lanes exist; use off-peak travel."],
            "community": ["Petition for BRT-lite on the 3 busiest corridors; formalize tempo stops."],
            "industrial": ["Stagger office hours (8/9/10 AM starts); freight delivery 10 PM-6 AM only."],
            "government": ["Build 3 BRT-lite corridors; 50 km protected cycle lanes in 2 years."],
        },
        "HAI": {
            "individual": ["Register with nearest primary clinic; know the 30-min emergency route."],
            "community": ["Weekly mobile clinic rotation; train 20 health volunteers per ward."],
            "industrial": ["Workplace clinics for 500+ employee sites; annual health screening."],
            "government": ["20 mobile clinics; hospital catchment mapping; digitized referrals."],
        },
        "CRI": {
            "individual": ["Know your ward's shelter location; keep 72-hour emergency kit."],
            "community": ["Annual pre-monsoon drill (April); ward disaster fund with triggers."],
            "industrial": ["Business continuity plans; backup power for critical operations."],
            "government": ["Multi-hazard ward maps; 100 schools retrofitted as shelters; city-wide drill."],
        },
        "SCI": {
            "individual": ["Ensure birth registration + NID for all household members (service gateway)."],
            "community": ["Slum upgrading: 10 settlements/year with water, sanitation, drainage."],
            "industrial": ["Hire 30% workforce from vulnerable wards; fund vocational training."],
            "government": ["Vulnerability-targeted safety nets; annual ward dashboards."],
        },
        "DRI": {
            "individual": ["72-hour kit: water, food, medicine, documents, power bank."],
            "community": ["Stockpile at 50 ward centers; neighborhood response teams."],
            "industrial": ["MOUs for emergency logistics; backup supply chains."],
            "government": ["Annual readiness scorecard per ward; audit hospitals/schools for resilience."],
        },
    }
    return table.get(ikey, {}).get(level, [])


def build_hwi_detail(hwi_score, hwi_label, indices, weights):
    """Perfect HWI breakdown with per-index contributions."""
    contributions = []
    wsum, wtot = 0.0, 0.0
    for ikey, w in weights.items():
        idx = indices.get(ikey, {})
        s = idx.get("score")
        if s is not None:
            contrib = w * s
            wsum += contrib
            wtot += w
            contributions.append({
                "index": ikey,
                "index_name": idx.get("name"),
                "score": s,
                "label": idx.get("label"),
                "weight": w,
                "weighted_contribution": round(contrib, 2),
            })
    # Sort by contribution (lowest first = needs most attention)
    contributions.sort(key=lambda x: x["score"] if x["score"] else 999)

    detail = {
        "score": hwi_score,
        "label": hwi_label,
        "method": "Weighted mean of 6 domain indices (v1.0)",
        "weights": weights,
        "interpretation": (
            f"The Human Wellbeing Index of {hwi_score}/100 ({hwi_label}) means that, "
            f"across air quality, heat, healthcare access, water security, social vulnerability, "
            f"and green environment, the area is {hwi_label.lower()}. "
        ),
        "contributions": contributions,
        "weakest_link": contributions[0] if contributions else None,
        "strongest_link": contributions[-1] if contributions else None,
    }
    if contributions:
        wl = contributions[0]
        detail["interpretation"] += (
            f"The weakest pillar is {wl['index_name']} ({wl['index']}) at {wl['score']}/100. "
            f"Lifting it by 10 points would raise the HWI by {round(wl['weight']*10, 1)} points. "
            f"This is where intervention money works hardest."
        )
    return detail
