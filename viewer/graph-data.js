const GRAPH = {
  "nodes": [
    {
      "id": 0,
      "label": "Cash Flow Forecast",
      "group": "Finance",
      "path": "Finance/Cash-Flow-Forecast.md",
      "excerpt": "Cash Flow Forecast The 13-week cash flow forecast is the single most-watched document at Maple Street Roasters. Helen and the bookkeeper rebuild it every Friday afternoon using actuals from the Square Register settlement, payroll runs, and any invoice postings from the prior seven days. The output is a rolling projection of the operating account balance for each of the next 13 Fridays. Key inputs the forecast depends on: Daily card settlement averages pulled from Square (we use a 14-day rolling mean) Net-30 and Net-15 vendor outflows governed by Supplier Payment Terms Bi-weekly payroll and the monthly rent debit on the 1st Seasonal revenue swings (December rush, late-January lull) Reserve…"
    },
    {
      "id": 1,
      "label": "Monthly Budget",
      "group": "Finance",
      "path": "Finance/Monthly-Budget.md",
      "excerpt": "Monthly Budget Maple Street Roasters runs a 12-month rolling budget that the owner (Helen) revises on the second Monday of each month. The budget is built bottom-up from category owners — green coffee, dairy, packaging, payroll, marketing — and reconciled against actuals in QuickBooks. The headline targets for January 2025 are revenue of $94,000 and total controllable expenses under $61,000, leaving a 35% gross margin before rent and depreciation. Budget categories: Green coffee and roastery supplies: $16,500 Cafe COGS (milk, syrups, pastries): $9,200 Payroll (12 staff, hourly + salary): $24,800 Rent and utilities: $6,900 Marketing and loyalty: $1,800 Equipment maintenance reserve: $1,800…"
    },
    {
      "id": 2,
      "label": "Quarterly Taxes",
      "group": "Finance",
      "path": "Finance/Quarterly-Taxes.md",
      "excerpt": "Quarterly Taxes Maple Street Roasters files quarterly estimated federal and state taxes, with the bookkeeper closing the books five business days before each quarterly deadline. The Q4 payment for 2024 was $11,400 federal and $2,900 state, and we hold those funds in a dedicated tax savings account so the money is never in the operating account when the IRS draft hits. Quarterly close checklist: Reconcile QuickBooks to bank and Square settlement reports Pull payroll summaries from Gusto for the quarter Apply depreciation entries for the Probat L5 and La Marzocco machines Compute sales tax owed across cafe and wholesale channels Review the monthly budget actuals against projection for the…"
    },
    {
      "id": 3,
      "label": "Supplier Payment Terms",
      "group": "Finance",
      "path": "Finance/Supplier-Payment-Terms.md",
      "excerpt": "Supplier Payment Terms Every vendor at Maple Street Roasters has a negotiated payment term recorded in the master vendor sheet. We do not pay on receipt — we pay on terms, and the discipline of that is what keeps our cash position healthy. The bookkeeper runs AP every Tuesday and Friday, and any invoice older than its term gets flagged red on the dashboard. Vendor terms at a glance: Coffee Bean Importers (green coffee): Net-30 from invoice, 2% discount if paid in 10 days Local Dairy Partner (milk, cream, yogurt): Net-15, delivered Tue/Fri/Sat Packaging Vendors (cups, lids, bags): Net-45, minimum order $750 Pastry suppliers: COD or Net-7 depending on partner Equipment technician: Net-30 on…"
    },
    {
      "id": 4,
      "label": "Barista Training",
      "group": "HR",
      "path": "HR/Barista-Training.md",
      "excerpt": "Barista Training Every new barista at Maple Street Roasters goes through a two-week structured training before they are allowed to solo on the espresso bar. Training is owned by our lead barista (Marco) and runs in cohorts of one to two trainees at a time so the cafe never carries two learners on the same shift. The curriculum is pinned in a binder behind the bar and mirrors the modules in our internal wiki. Two-week training modules: Week 1: cafe orientation, safety, register, drip and pour-over Week 1 end: dialing in the Espresso Blend Recipe with Marco Week 2: milk steaming, latte art, drink build standards Week 2 mid: customer service standards and conflict de-escalation Week 2 end…"
    },
    {
      "id": 5,
      "label": "Hiring Process",
      "group": "HR",
      "path": "HR/Hiring-Process.md",
      "excerpt": "Hiring Process We hire deliberately and slowly at Maple Street Roasters — a bad hire costs us more than a slow hire. The process is owned by Helen with input from Marco for barista roles and from the head roaster for roastery roles. We post on our website, on a local hospitality board, and on Instagram; we do not use general-purpose job boards because they generate too much noise for a 12-person shop. Hiring steps: Application via our website form (no resumes-only walk-ins accepted) Phone screen with Helen, 15 minutes, confirms availability and pay band In-person trial shift, paid 2 hours, working alongside Marco Reference check (two references, both within the last 18 months) Final…"
    },
    {
      "id": 6,
      "label": "Performance Reviews",
      "group": "HR",
      "path": "HR/Performance-Reviews.md",
      "excerpt": "Performance Reviews Performance reviews at Maple Street Roasters are a structured, ongoing conversation rather than a once-a-year event. Every staff member gets a 30-day, 60-day, and 90-day check-in during onboarding, then a formal review every six months after that. Reviews are owned by the relevant team lead (Marco for baristas, head roaster for roastery) with Helen signing off. Review components: A short self-assessment submitted 48 hours before the review A manager assessment against the role's competency checklist A review of the trainee sign-off from Barista Training (for new hires) Specific feedback on three recent shifts, with timestamps from the schedule A goal-setting conversation…"
    },
    {
      "id": 7,
      "label": "Shift Scheduling",
      "group": "HR",
      "path": "HR/Shift-Scheduling.md",
      "excerpt": "Shift Scheduling Shifts at Maple Street Roasters are published two weeks in advance on a shared Google Calendar that everyone can subscribe to. Helen owns the master schedule, with Marco covering cafe-side requests and the head roaster covering roastery coverage. The schedule is built Sunday evening for the week starting 11 days later, which gives everyone time to swap before it locks. Shift structure: Open: 5:45 AM–1:00 PM (2 baristas minimum, 3 on weekends) Mid: 10:00 AM–4:00 PM (1 barista, peaks with lunch rush) Close: 1:00 PM–9:30 PM (2 baristas, closer owns the floor after 8:00 PM) Roastery: 6:00 AM–2:00 PM Monday–Friday (head roaster plus one apprentice) Coverage rules are strict. The…"
    },
    {
      "id": 8,
      "label": "Email Newsletter",
      "group": "Marketing",
      "path": "Marketing/Email-Newsletter.md",
      "excerpt": "Email Newsletter Our weekly email newsletter goes out every Tuesday at 7:00 AM to roughly 3,400 subscribers. We send via Mailchimp, with the list synced from Square and our website sign-up form. Open rate averages 38% and click-through 4.2%, both of which we track in a simple Google Sheet so trends are visible at a glance. The list is our most-owned marketing asset — no algorithm changes can take it away. Standard newsletter structure: Header with the week's roast of the day Lead story: a campaign, a new bean, or a staff spotlight A short barista tip or brew-at-home pointer A recap of the past week's highlights from the Social Media Calendar A footer with hours, address, and unsubscribe We…"
    },
    {
      "id": 9,
      "label": "Loyalty Program",
      "group": "Marketing",
      "path": "Marketing/Loyalty-Program.md",
      "excerpt": "Loyalty Program Our loyalty program runs on the Square Loyalty layer bolted to the Square Register. Customers earn one star per $1 spent, with a free 12oz drip coffee at 50 stars and a free specialty drink at 120 stars. Enrollment is free and happens at the register in about 20 seconds via phone number. As of January 2025 we have 2,140 active members, with about 680 of them transacting at least once a week. Program tiers and rewards: 50 stars: free 12oz drip coffee 120 stars: free specialty drink (any size) 200 stars: free 1lb bag of house blend beans 350 stars: free branded tote or mug from the merchandise shelf Birthday: free pastry, no stars required, auto-sent via Square The program is…"
    },
    {
      "id": 10,
      "label": "Seasonal Campaigns",
      "group": "Marketing",
      "path": "Marketing/Seasonal-Campaigns.md",
      "excerpt": "Seasonal Campaigns Seasonal campaigns are Maple Street Roasters' main engine for getting customers to do something other than their usual order. We run four anchor campaigns per year — Spring Bloom (March), Summer Cold Brew (June), Harvest (September), and Holiday (November–December) — each with a defined launch date, asset kit, and exit date. A campaign without a hard exit date is a campaign that quietly becomes wallpaper. Campaign build blocks: A limited-time drink or two from the Seasonal Menu A dedicated hashtag and 8–12 pre-shot assets in Notion A four-week posting plan slotted into the Social Media Calendar An email blast timed to launch day and a mid-campaign nudge An in-cafe…"
    },
    {
      "id": 11,
      "label": "Social Media Calendar",
      "group": "Marketing",
      "path": "Marketing/Social-Media-Calendar.md",
      "excerpt": "Social Media Calendar Maple Street Roasters runs a single shared content calendar in Notion, owned by our part-time marketing coordinator (Jess). The calendar covers Instagram (primary), Facebook, and TikTok, with a two-week look-ahead so the cafe team can stage photos during slow periods. We post 5 times per week on Instagram, 3 times on TikTok, and once on Facebook — anything beyond that hits diminishing returns for our audience size. Weekly posting rhythm: Monday: \"Roast of the week\" origin story with Probat L5 in frame Wednesday: behind-the-scenes barista or roaster video (vertical, 15–30s) Friday: customer photo repost + weekend hours Saturday: pastry or seasonal drink close-up Sunday…"
    },
    {
      "id": 12,
      "label": "Closing Procedures",
      "group": "Operations",
      "path": "Operations/Closing-Procedures.md",
      "excerpt": "Closing Procedures Close at Maple Street Roasters runs from 8:00 PM to roughly 9:30 PM. The closer (usually Devon or Aisha) owns the floor from the last customer out the door until the alarm is armed. The close is the mirror image of the Daily Opening Checklist: every step that opens the cafe has a corresponding teardown, and a sloppy close guarantees a chaotic morning. Close-of-day sequence: Lock front door at 8:00 PM, post \"closed\" sign, finish in-cafe tickets Pull drip urns, dump grounds, run hot water rinse cycle Backflush both espresso groups with cafiza, scrub portafilters Wipe down counters, pastry case glass, and the Probat L5 staging table Restock cups, lids, to-go boxes for…"
    },
    {
      "id": 13,
      "label": "Daily Opening Checklist",
      "group": "Operations",
      "path": "Operations/Daily-Opening-Checklist.md",
      "excerpt": "Daily Opening Checklist Opening shift at Maple Street Roasters kicks off at 5:45 AM sharp. The opener (typically Marco or Priya) is responsible for getting the cafe ready before the 6:30 AM door unlock. Our opening routine is built on three pillars: safety, cleanliness, and a calibrated first shot. New hires rehearse this checklist during Barista Training before they are ever handed the opener keys, and any deviations get logged in the binder behind the register. Pre-open sequence: Unlock rear door, disarm ADT panel, switch on main breakers Start Probat L5 warm-up cycle (target 410°F drum by 7:00 AM) Backflush both espresso groups, purge steam wands, calibrate shot time to 26s Wipe down…"
    },
    {
      "id": 14,
      "label": "Equipment Maintenance",
      "group": "Operations",
      "path": "Operations/Equipment-Maintenance.md",
      "excerpt": "Equipment Maintenance Maple Street Roasters runs a tight, slightly aging equipment fleet that we baby ruthlessly. The Probat L5 roaster is the heart of the operation, flanked by a 2021 Mahlkönig EK43 grinder, two La Marzocco Linea PB espresso machines, and the workhorse Square Register POS terminals. Every piece has a maintenance card on the wall above it listing daily, weekly, and monthly tasks, plus the technician's direct cell. Daily and weekly tasks: Espresso machines: backflush with cafiza each close, group gaskets inspected Mondays Grinders: burr brush and vacuum nightly, full burr inspection last Friday of each month Roaster: chaff cyclone emptied daily, exhaust probe calibration…"
    },
    {
      "id": 15,
      "label": "Inventory Rotation",
      "group": "Operations",
      "path": "Operations/Inventory-Rotation.md",
      "excerpt": "Inventory Rotation All stock at Maple Street Roasters follows a strict first-in, first-out (FIFO) discipline. Beans, milk, syrups, and pastries all carry a green date dot for week received and a red dot for week to sell by. Any item past its red dot is pulled from service and logged for waste reconciliation at end of week. Accurate rotation is what keeps our cost-of-goods variance under 2% month over month, and it directly informs how we time payments against the schedule laid out in Supplier Payment Terms. Green coffee inventory lives in the rear storage room on the gravity-fed shelving we built out in 2023. Each lot is tagged with origin, arrival date, and projected roast-through date…"
    },
    {
      "id": 16,
      "label": "Espresso Blend Recipe",
      "group": "Products",
      "path": "Products/Espresso-Blend-Recipe.md",
      "excerpt": "Espresso Blend Recipe Our house espresso blend, \"Maple Street No. 4,\" is a four-component blend designed to hit a chocolate-forward, medium-body shot that holds up in milk. The recipe has been stable since spring 2023, with minor tweaks only when a component lot changes character. All four components are sourced through Coffee Bean Importers, which simplifies logistics and keeps our green coffee relationship consolidated with one accountable partner. The target shot is 18g in, 36g out, in 26 seconds, pulled on the La Marzocco Linea PB at 9.2 bar. Blend components (by weight, green): 40% Brazil Cerrado, natural process 25% Colombia Huila, washed 20% Guatemala Antigua, washed 15% Ethiopia…"
    },
    {
      "id": 17,
      "label": "Merchandise Catalog",
      "group": "Products",
      "path": "Products/Merchandise-Catalog.md",
      "excerpt": "Merchandise Catalog The merchandise catalog at Maple Street Roasters is intentionally small — about 12 SKUs at any given time, rotating seasonally. Merchandise is roughly 6% of revenue but a much larger share of margin and brand presence, so we treat it as a marketing line as much as a product line. Every SKU has to justify its shelf space within 90 days or it gets rotated out. Standing catalog: 12oz and 1lb bags of house blend and single-origin beans Branded ceramic mug (two colors, charcoal and cream) Canvas tote with our roastery line drawing French press (Bodum Brazil, branded box) Porcelain espresso cups (set of two) Brewing scale (0.1g resolution, branded) Sticker pack and enamel pin…"
    },
    {
      "id": 18,
      "label": "Pastry Sourcing",
      "group": "Products",
      "path": "Products/Pastry-Sourcing.md",
      "excerpt": "Pastry Sourcing Our pastries come from two local bakery partners plus an in-house baked-goods program for a small set of items. The split is deliberate: we get reliability and volume from the partners, and we get a signature offering from the in-house program. About 65% of pastry sales by units come from partners, and the in-house items account for the higher-margin 35% by revenue. Pastry lineup and sources: Almond croissant, plain croissant, pain au chocolat — Louve Bakery (delivered Tue/Fri) Vegan banana bread, gluten-free brownie — in-house (baked Mon/Thu) Seasonal savory galette — Louve Bakery (rotates with the Seasonal Menu) Morning bun and maple scone — Pioneer Pastry (delivered…"
    },
    {
      "id": 19,
      "label": "Seasonal Menu",
      "group": "Products",
      "path": "Products/Seasonal-Menu.md",
      "excerpt": "Seasonal Menu The seasonal menu at Maple Street Roasters rotates four times a year and is the main way we keep the cafe experience fresh without constantly changing our core offering. Each seasonal menu runs roughly 10–12 weeks and features two specialty drinks, one non-coffee option, and a rotating syrup made in-house. The core menu (drip, espresso drinks, pour-over) stays put. Spring 2025 seasonal menu: \"Maple Cardamom Latte\" — house espresso, maple syrup, cardamom tincture, oat milk option \"Cold Brew Tonic\" — cold brew, tonic, dehydrated orange wheel \"Honey Chamomile Steamer\" (non-coffee) House-made cardamom-vanilla syrup (replaces winter's gingerbread) Every drink on the seasonal menu…"
    },
    {
      "id": 20,
      "label": "Annual Roadmap",
      "group": "Strategy",
      "path": "Strategy/Annual-Roadmap.md",
      "excerpt": "Annual Roadmap The annual roadmap is Maple Street Roasters' three-year-looking strategic document, refreshed each December and reviewed quarterly. Helen owns the roadmap with input from the leads, and it sits above the Monthly Budget and Quarterly Taxes in our planning stack. The roadmap is not a wish list — every item on it has an owner, a budget envelope, and a defined checkpoint. 2025 roadmap themes: Open a second cafe location (target Q3 2025, contingent on site search) Grow wholesale green coffee accounts from 4 to 10 Launch a subscription program (monthly bean delivery) Reduce single-use packaging by 30% by Q4 2025 Add one roastery apprentice role (tied to Performance Reviews…"
    },
    {
      "id": 21,
      "label": "Customer Personas",
      "group": "Strategy",
      "path": "Strategy/Customer-Personas.md",
      "excerpt": "Customer Personas We plan all of our marketing and a fair amount of our product decisions against four customer personas. The personas were built in 2022 from a mix of register data, loyalty signups, and a 200-person customer survey, and they get revisited every January. They are not market segments in the abstract sense — each persona maps to a real person we know by name. The four personas: \"Daily Regular\" — Marco's archetype, in 5 mornings a week, drip coffee, knows staff by name \"Weekend Treat\" — comes Saturday with a partner, specialty drink, pastry, lingers \"Remote Worker\" — weekday mid-morning, large drip, occupies a table for 2–3 hours \"Wholesale Buyer\" — local cafe or restaurant…"
    },
    {
      "id": 22,
      "label": "Coffee Bean Importers",
      "group": "Suppliers",
      "path": "Suppliers/Coffee-Bean-Importers.md",
      "excerpt": "Coffee Bean Importers Coffee Bean Importers is our primary green coffee partner and has been since we opened in 2019. They're a mid-size importer based in Minneapolis with direct trade relationships in Brazil, Colombia, Guatemala, and Ethiopia — which conveniently maps to the four components of our Espresso Blend Recipe. We buy roughly 1,800 lb of green coffee per month through them, split across standing lots and seasonal spot buys. Standing relationship details: Account manager: Daniela Reyes, reachable by cell and Slack Net-30 terms, 2% discount if paid within 10 days (see Supplier Payment Terms) Minimum order: 1 full bag (70kg / 154lb) per origin Samples shipped free before any new lot…"
    },
    {
      "id": 23,
      "label": "Local Dairy Partner",
      "group": "Suppliers",
      "path": "Suppliers/Local-Dairy-Partner.md",
      "excerpt": "Local Dairy Partner Our dairy partner is Cream Ridge Dairy, a family-owned operation about 40 minutes outside the city. They deliver three times a week (Tuesday, Friday, Saturday) and have been our sole dairy supplier since 2020. The relationship matters more than the size of the line item — dairy is the ingredient most likely to derail a service if it's late or short, so reliability wins over price. Standing weekly order: 18 gallons whole milk (the workhorse for espresso drinks) 6 gallons 2% milk (lower-volume customer requests) 4 gallons oat milk (barista edition, the Oatly tap) 2 gallons heavy cream (Seasonal Menu steamers and sauces) 12 quarts half-and-half (for drip coffee station) 6…"
    },
    {
      "id": 24,
      "label": "Packaging Vendors",
      "group": "Suppliers",
      "path": "Suppliers/Packaging-Vendors.md",
      "excerpt": "Packaging Vendors Packaging at Maple Street Roasters is split across two vendors. We use Printed Cup Company for our branded hot and cold cups, and EcoPack Supply for lids, to-go containers, and mailers. The split keeps us from being single-source dependent and lets us negotiate each category on its own merits. Packaging is a deceptively large line item — roughly $4,200 per month across both vendors combined. Standing SKU list: 12oz, 16oz, 20oz hot cups (Printed Cup Company, custom Maple Street print) 12oz, 16oz, 24oz cold cups (Printed Cup Company, clear) Matching lids for all cup sizes (EcoPack Supply) 8oz and 16oz to-go boxes for pastries (EcoPack Supply) Branded mailers and tissue for…"
    },
    {
      "id": 25,
      "label": "Espresso Machine Needs Descaling Weekly",
      "group": "captures",
      "path": "captures/Espresso-Machine-Needs-Descaling-Weekly.md",
      "excerpt": "Espresso Machine Needs Descaling Weekly the espresso machine needs descaling weekly Related: Espresso Blend Recipe"
    },
    {
      "id": 26,
      "label": "Pastry Order Arrives Every Tuesday",
      "group": "captures",
      "path": "captures/Pastry-Order-Arrives-Every-Tuesday.md",
      "excerpt": "Pastry Order Arrives Every Tuesday the pastry order arrives every Tuesday at 6am Related: Pastry Sourcing"
    }
  ],
  "links": [
    {
      "source": 0,
      "target": 1
    },
    {
      "source": 0,
      "target": 2
    },
    {
      "source": 0,
      "target": 3
    },
    {
      "source": 0,
      "target": 12
    },
    {
      "source": 0,
      "target": 15
    },
    {
      "source": 0,
      "target": 22
    },
    {
      "source": 0,
      "target": 23
    },
    {
      "source": 1,
      "target": 2
    },
    {
      "source": 1,
      "target": 14
    },
    {
      "source": 1,
      "target": 20
    },
    {
      "source": 1,
      "target": 21
    },
    {
      "source": 2,
      "target": 14
    },
    {
      "source": 2,
      "target": 20
    },
    {
      "source": 2,
      "target": 21
    },
    {
      "source": 2,
      "target": 24
    },
    {
      "source": 3,
      "target": 15
    },
    {
      "source": 3,
      "target": 22
    },
    {
      "source": 3,
      "target": 23
    },
    {
      "source": 3,
      "target": 24
    },
    {
      "source": 4,
      "target": 5
    },
    {
      "source": 4,
      "target": 6
    },
    {
      "source": 4,
      "target": 7
    },
    {
      "source": 4,
      "target": 13
    },
    {
      "source": 4,
      "target": 16
    },
    {
      "source": 5,
      "target": 6
    },
    {
      "source": 5,
      "target": 7
    },
    {
      "source": 6,
      "target": 7
    },
    {
      "source": 6,
      "target": 12
    },
    {
      "source": 6,
      "target": 13
    },
    {
      "source": 6,
      "target": 20
    },
    {
      "source": 7,
      "target": 12
    },
    {
      "source": 7,
      "target": 13
    },
    {
      "source": 8,
      "target": 9
    },
    {
      "source": 8,
      "target": 10
    },
    {
      "source": 8,
      "target": 11
    },
    {
      "source": 8,
      "target": 21
    },
    {
      "source": 9,
      "target": 11
    },
    {
      "source": 9,
      "target": 17
    },
    {
      "source": 9,
      "target": 21
    },
    {
      "source": 10,
      "target": 11
    },
    {
      "source": 10,
      "target": 17
    },
    {
      "source": 10,
      "target": 19
    },
    {
      "source": 10,
      "target": 20
    },
    {
      "source": 11,
      "target": 17
    },
    {
      "source": 11,
      "target": 21
    },
    {
      "source": 12,
      "target": 13
    },
    {
      "source": 13,
      "target": 14
    },
    {
      "source": 13,
      "target": 15
    },
    {
      "source": 14,
      "target": 16
    },
    {
      "source": 15,
      "target": 18
    },
    {
      "source": 15,
      "target": 22
    },
    {
      "source": 16,
      "target": 19
    },
    {
      "source": 16,
      "target": 22
    },
    {
      "source": 16,
      "target": 25
    },
    {
      "source": 17,
      "target": 20
    },
    {
      "source": 17,
      "target": 24
    },
    {
      "source": 18,
      "target": 19
    },
    {
      "source": 18,
      "target": 23
    },
    {
      "source": 18,
      "target": 24
    },
    {
      "source": 18,
      "target": 26
    },
    {
      "source": 19,
      "target": 21
    },
    {
      "source": 19,
      "target": 23
    },
    {
      "source": 20,
      "target": 21
    }
  ]
};
if (typeof window !== "undefined") { window.GRAPH = GRAPH; }
