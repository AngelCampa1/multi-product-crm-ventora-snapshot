/**
 * scripts/demo/dataset.ts
 *
 * Pure data literals for the local screenshot demo dataset. No I/O here:
 * scripts/seed-demo.ts is the only place that talks to the network/DB.
 *
 * Fictional-only constraint (see the no-fabrication rule in CLAUDE.md):
 *   - Companies are drawn ONLY from FICTIONAL_COMPANIES below.
 *   - Every customer email ends in @example.com.
 *   - Every customer.notes explicitly says this is a fictional demo record.
 *   - No fabricated ratings/quotes are attributed to real people or companies.
 *
 * Firewall safety (see src/lib/firewall.ts):
 *   - camaudit-v2 is the ONLY product with firewall_group = "cre".
 *   - Any customer touching camaudit-v2 (directly or via testimonial/review/
 *     feedback) must touch NO other product.
 *   - Multi-product customers may only combine grantpipe + ventora-crm.
 *   - floriva-web is left completely empty on purpose (deliberate empty-state
 *     fixture) — no customer, testimonial, review, or feedback item below
 *     references it.
 */

// ---------------------------------------------------------------------------
// Frozen clock — every timestamp in this file is derived from this anchor so
// re-running the seed produces byte-identical dates (no "today" drift).
// ---------------------------------------------------------------------------

const ANCHOR = Date.parse("2026-06-01T12:00:00.000Z");

/** Returns an ISO timestamp `hoursOffset` hours after the anchor. */
export function frozenIso(hoursOffset: number): string {
  return new Date(ANCHOR + hoursOffset * 60 * 60 * 1000).toISOString();
}

export const FICTIONAL_COMPANIES = [
  "Acme Corporation",
  "Globex",
  "Initech",
  "Umbrella Industries",
  "Wayne Enterprises",
  "Northwind Traders",
  "Stark Industries",
  "Hooli",
  "Cyberdyne Systems",
  "Soylent Corp",
  "Vandelay Industries",
] as const;

const DEMO_NOTE = "Fictional demo record — not a real customer.";

// ---------------------------------------------------------------------------
// Product slugs already seeded by db:seed / configure-product-origins.
// ---------------------------------------------------------------------------

export const PRODUCT_SLUGS = {
  camaudit: "camaudit-v2",
  grantpipe: "grantpipe",
  crm: "ventora-crm",
  floriva: "floriva-web", // deliberately never referenced below
} as const;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export type LifecycleStage = "lead" | "active" | "churned" | "champion";

export interface DemoCustomer {
  /** Stable local key used to cross-reference this customer from other tables below. */
  key: string;
  name: string;
  email: string;
  company: (typeof FICTIONAL_COMPANIES)[number];
  role: string;
  twitter?: string;
  linkedin?: string;
  website?: string;
  lifecycle: LifecycleStage;
  notes: string;
  /** Product slugs to link at creation time (POST /customers product_ids). */
  productSlugs: string[];
  /** Hours after ANCHOR — frozen onto customers.created_at / updated_at in Phase B. */
  createdAtHours: number;
}

export const CUSTOMERS: DemoCustomer[] = [
  // --- camaudit-v2 only (firewall_group "cre") -----------------------------
  {
    key: "c1",
    name: "Priya Natarajan",
    email: "priya.natarajan@example.com",
    company: "Wayne Enterprises",
    role: "VP of Real Estate",
    linkedin: "https://linkedin.com/in/priya-natarajan-demo",
    lifecycle: "champion",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.camaudit],
    createdAtHours: -24 * 60,
  },
  {
    key: "c2",
    name: "Marcus Webb",
    email: "marcus.webb@example.com",
    company: "Stark Industries",
    role: "Director of Facilities",
    linkedin: "https://linkedin.com/in/marcus-webb-demo",
    lifecycle: "champion",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.camaudit],
    createdAtHours: -23 * 60,
  },
  {
    key: "c3",
    name: "Elena Ruiz",
    email: "elena.ruiz@example.com",
    company: "Cyberdyne Systems",
    role: "Lease Administrator",
    lifecycle: "active",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.camaudit],
    createdAtHours: -22 * 60,
  },
  {
    key: "c4",
    name: "Tobias Green",
    email: "tobias.green@example.com",
    company: "Umbrella Industries",
    role: "Portfolio Controller",
    lifecycle: "active",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.camaudit],
    createdAtHours: -21 * 60,
  },
  {
    key: "c5",
    name: "Alicia Moreno",
    email: "alicia.moreno@example.com",
    company: "Soylent Corp",
    role: "Head of Corporate Real Estate",
    website: "https://soylentcorp.example.com",
    lifecycle: "champion",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.camaudit],
    createdAtHours: -20 * 60,
  },

  // --- grantpipe only -------------------------------------------------------
  {
    key: "c6",
    name: "Daniel Okafor",
    email: "daniel.okafor@example.com",
    company: "Northwind Traders",
    role: "Grants Manager",
    lifecycle: "active",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.grantpipe],
    createdAtHours: -19 * 60,
  },
  {
    key: "c7",
    name: "Sofia Bianchi",
    email: "sofia.bianchi@example.com",
    company: "Hooli",
    role: "Program Officer",
    lifecycle: "lead",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.grantpipe],
    createdAtHours: -18 * 60,
  },

  // --- ventora-crm only -------------------------------------------------------
  {
    key: "c8",
    name: "Jordan Ellis",
    email: "jordan.ellis@example.com",
    company: "Vandelay Industries",
    role: "Customer Marketing Lead",
    twitter: "jordanellis_demo",
    lifecycle: "active",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.crm],
    createdAtHours: -17 * 60,
  },
  {
    key: "c9",
    name: "Grace Whitfield",
    email: "grace.whitfield@example.com",
    company: "Globex",
    role: "RevOps Manager",
    lifecycle: "lead",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.crm],
    createdAtHours: -16 * 60,
  },

  // --- grantpipe + ventora-crm (the only allowed multi-product pairing) -----
  {
    key: "c10",
    name: "Hannah Kim",
    email: "hannah.kim@example.com",
    company: "Initech",
    role: "Head of Growth",
    linkedin: "https://linkedin.com/in/hannah-kim-demo",
    lifecycle: "champion",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.grantpipe, PRODUCT_SLUGS.crm],
    createdAtHours: -15 * 60,
  },
  {
    key: "c11",
    name: "Owen Faraday",
    email: "owen.faraday@example.com",
    company: "Acme Corporation",
    role: "Operations Director",
    lifecycle: "active",
    notes: DEMO_NOTE,
    productSlugs: [PRODUCT_SLUGS.grantpipe, PRODUCT_SLUGS.crm],
    createdAtHours: -14 * 60,
  },

  // --- lead with no product links yet (pure CRM record) ---------------------
  {
    key: "c12",
    name: "Renata Silva",
    email: "renata.silva@example.com",
    company: "Acme Corporation",
    role: "Procurement Analyst",
    lifecycle: "lead",
    notes: DEMO_NOTE,
    productSlugs: [],
    createdAtHours: -13 * 60,
  },
];

// ---------------------------------------------------------------------------
// Testimonials — 11 total (6 approved / 5 pending), exactly 2 approved+featured.
// `customerKey` cross-references CUSTOMERS[].key; `productSlug` must be one of
// that customer's linked productSlugs.
// ---------------------------------------------------------------------------

export interface DemoTestimonial {
  key: string;
  customerKey: string;
  productSlug: string;
  quote: string;
  source: "twitter" | "email" | "manual" | "widget" | "import";
  sourceUrl?: string;
  rating: number | null;
  approved: boolean;
  featured: boolean;
  createdAtHours: number;
}

export const TESTIMONIALS: DemoTestimonial[] = [
  {
    key: "t1",
    customerKey: "c1",
    productSlug: PRODUCT_SLUGS.camaudit,
    quote:
      "Camaudit found a six-figure CAM overcharge in our first portfolio review. The report was clean enough to hand straight to our landlord's counsel.",
    source: "email",
    rating: 5,
    approved: true,
    featured: true,
    createdAtHours: -24 * 55,
  },
  {
    key: "t2",
    customerKey: "c2",
    productSlug: PRODUCT_SLUGS.camaudit,
    quote:
      "We used to budget two weeks per lease for a CAM reconciliation. Camaudit gets us a defensible variance report in under a day.",
    source: "manual",
    rating: 5,
    approved: true,
    featured: true,
    createdAtHours: -24 * 50,
  },
  {
    key: "t3",
    customerKey: "c3",
    productSlug: PRODUCT_SLUGS.camaudit,
    quote:
      "The gross-up detection alone paid for a year of the subscription. Our lease admin team trusts the flags enough to act on them directly.",
    source: "widget",
    rating: 4,
    approved: true,
    featured: false,
    createdAtHours: -24 * 45,
  },
  {
    key: "t4",
    customerKey: "c4",
    productSlug: PRODUCT_SLUGS.camaudit,
    quote: "Solid detection rules and the base-year comparisons are exactly what our controller needed.",
    source: "manual",
    rating: null,
    approved: true,
    featured: false,
    createdAtHours: -24 * 40,
  },
  {
    key: "t5",
    customerKey: "c5",
    productSlug: PRODUCT_SLUGS.camaudit,
    quote:
      // Deliberately the longest quote in the set — the wall-grid widget lets a
      // quote run to full length while wall-carousel clamps it, so this record
      // is what makes that difference visible in the captured previews. Keep it
      // near this length: much longer and it stretches its whole grid row.
      "We reconciled CAM statements by hand across forty-plus leases, so overcharges slipped through every year. The detection rules caught duplicate gross-ups across three buildings our previous auditor had missed twice.",
    source: "email",
    rating: 5,
    approved: true,
    featured: false,
    createdAtHours: -24 * 35,
  },
  {
    key: "t6",
    customerKey: "c6",
    productSlug: PRODUCT_SLUGS.grantpipe,
    quote:
      "GrantPipe keeps every deadline and every reviewer note in one pipeline. We stopped losing track of which draft was current.",
    source: "email",
    rating: 4,
    approved: true,
    featured: false,
    createdAtHours: -24 * 30,
  },
  {
    key: "t7",
    customerKey: "c7",
    productSlug: PRODUCT_SLUGS.grantpipe,
    quote: "The reporting view makes board updates painless — I export it straight into our quarterly deck.",
    source: "widget",
    rating: 3,
    approved: false,
    featured: false,
    createdAtHours: -24 * 26,
  },
  {
    key: "t8",
    customerKey: "c8",
    productSlug: PRODUCT_SLUGS.crm,
    quote:
      "Ventora CRM's Wall of Fame widget went live on our marketing site in an afternoon, and the embed just kept working across every redesign since.",
    source: "manual",
    rating: 5,
    approved: false,
    featured: false,
    createdAtHours: -24 * 22,
  },
  {
    key: "t9",
    customerKey: "c9",
    productSlug: PRODUCT_SLUGS.crm,
    quote: "Setup took ten minutes. Support the same day.",
    source: "twitter",
    sourceUrl: "https://twitter.com/example/status/1000000000000000009",
    rating: null,
    approved: false,
    featured: false,
    createdAtHours: -24 * 18,
  },
  {
    key: "t10",
    customerKey: "c10",
    productSlug: PRODUCT_SLUGS.grantpipe,
    quote: "Our whole grants team moved off spreadsheets in a week and nobody asked to go back.",
    source: "manual",
    rating: 4,
    approved: false,
    featured: false,
    createdAtHours: -24 * 14,
  },
  {
    key: "t11",
    customerKey: "c11",
    productSlug: PRODUCT_SLUGS.grantpipe,
    quote: "The pipeline view is useful, but I'd like custom fields for internal approval stages.",
    source: "email",
    rating: 2,
    approved: false,
    featured: false,
    createdAtHours: -24 * 10,
  },
];

// ---------------------------------------------------------------------------
// Feedback — 14 items, all on camaudit-v2 so a single product filter shows
// a fully populated six-column board. Upvotes are globally distinct so
// column ordering is deterministic.
// ---------------------------------------------------------------------------

export interface DemoFeedback {
  key: string;
  customerKey: string | null;
  productSlug: string;
  type: "feature_request" | "bug" | "general";
  title: string;
  body: string;
  status: "new" | "triaged" | "planned" | "in_progress" | "shipped" | "declined";
  upvotes: number;
  createdAtHours: number;
}

export const FEEDBACK_ITEMS: DemoFeedback[] = [
  {
    key: "f1",
    customerKey: "c1",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Bulk export of demand letters",
    body: "We'd like to export every generated demand letter for a portfolio in one ZIP instead of one at a time.",
    status: "new",
    upvotes: 42,
    createdAtHours: -1,
  },
  {
    key: "f2",
    customerKey: "c2",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "bug",
    title: "Gross-up flag shows on non-gross-up leases",
    body: "Two leases without a gross-up clause are still triggering the gross-up detection rule.",
    status: "new",
    upvotes: 38,
    createdAtHours: -2,
  },
  {
    key: "f3",
    customerKey: null,
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "general",
    title: "Add a CAM cap explainer tooltip",
    body: "New analysts on our team keep asking what the CAM cap badge means — a tooltip would help onboarding.",
    status: "new",
    upvotes: 35,
    createdAtHours: -3,
  },
  {
    key: "f4",
    customerKey: "c3",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Custom base-year override per lease",
    body: "A few of our leases renegotiated their base year mid-term; we need to override it per lease.",
    status: "triaged",
    upvotes: 29,
    createdAtHours: -4,
  },
  {
    key: "f5",
    customerKey: "c4",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "bug",
    title: "Pro-rata share rounds oddly on renewal leases",
    body: "Renewal leases show a pro-rata share that's off by 0.01% compared to the signed amendment.",
    status: "triaged",
    upvotes: 26,
    createdAtHours: -5,
  },
  {
    key: "f6",
    customerKey: "c5",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Reconciliation statement side-by-side diff view",
    body: "Show the landlord's reconciliation statement next to our recalculated numbers, line by line.",
    status: "planned",
    upvotes: 22,
    createdAtHours: -6,
  },
  {
    key: "f7",
    customerKey: null,
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "general",
    title: "Support multi-currency portfolios",
    body: "Our EU portfolio bills in EUR; the dashboard currently assumes USD everywhere.",
    status: "planned",
    upvotes: 19,
    createdAtHours: -7,
  },
  {
    key: "f8",
    customerKey: "c1",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Saved detection-rule presets per portfolio",
    body: "Let us save a named set of detection rules and apply it to a whole portfolio in one click.",
    status: "planned",
    upvotes: 15,
    createdAtHours: -8,
  },
  {
    key: "f9",
    customerKey: "c2",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "bug",
    title: "PDF export drops the executive summary page",
    body: "The one-page executive summary is missing from the exported PDF on two recent audits.",
    status: "in_progress",
    upvotes: 12,
    createdAtHours: -9,
  },
  {
    key: "f10",
    customerKey: null,
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Slack notification when an audit finishes",
    body: "Ping a Slack channel when a batch audit run completes instead of requiring us to poll the dashboard.",
    status: "in_progress",
    upvotes: 9,
    createdAtHours: -10,
  },
  {
    key: "f11",
    customerKey: "c3",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "feature_request",
    title: "Role-based access for read-only reviewers",
    body: "Outside counsel should be able to view a report without being able to edit detection rules.",
    status: "shipped",
    upvotes: 7,
    createdAtHours: -11,
  },
  {
    key: "f12",
    customerKey: "c4",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "bug",
    title: "Date filter resets on page refresh",
    body: "The audit history date range filter resets to 'All time' every time the page reloads.",
    status: "shipped",
    upvotes: 5,
    createdAtHours: -12,
  },
  {
    key: "f13",
    customerKey: null,
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "general",
    title: "Dark mode for the audit dashboard",
    body: "Several of our analysts run late-night reconciliation sprints and asked for a dark theme.",
    status: "shipped",
    upvotes: 3,
    createdAtHours: -13,
  },
  {
    key: "f14",
    customerKey: "c5",
    productSlug: PRODUCT_SLUGS.camaudit,
    type: "general",
    title: "Rebrand the CAM cap badge color",
    body: "Requested a different badge color; after discussion this doesn't map to a real usability problem.",
    status: "declined",
    upvotes: 1,
    createdAtHours: -14,
  },
];

// ---------------------------------------------------------------------------
// Reviews — manual + csv go through the real admin API (Phase A) so
// dedup/validation runs for real. rss/g2/trustpilot are inserted directly via
// SQL in Phase B because their API import paths hit the live network.
// ---------------------------------------------------------------------------

export interface DemoManualReview {
  key: string;
  productSlug: string;
  body: string;
  authorName: string;
  rating: number;
  sourceUrl?: string;
}

export const MANUAL_REVIEWS: DemoManualReview[] = [
  {
    key: "rm1",
    productSlug: PRODUCT_SLUGS.camaudit,
    body: "Caught a duplicate CAM charge across two of our buildings within the first week of use.",
    authorName: "R. Delgado",
    rating: 5,
  },
  {
    key: "rm2",
    productSlug: PRODUCT_SLUGS.camaudit,
    body: "Good detection rules, wish the PDF export had our own letterhead option.",
    authorName: "K. Osei",
    rating: 4,
  },
  {
    key: "rm3",
    productSlug: PRODUCT_SLUGS.grantpipe,
    body: "Replaced three spreadsheets and a shared inbox. Our grants calendar finally makes sense.",
    authorName: "J. Fontaine",
    rating: 5,
  },
  {
    key: "rm4",
    productSlug: PRODUCT_SLUGS.crm,
    body: "The widget embed just works, and support answered our one question inside an hour.",
    authorName: "T. Abara",
    rating: 5,
  },
];

export interface DemoCsvReview {
  authorName: string;
  body: string;
  rating: number | "";
  sourceUrl?: string;
}

export interface DemoCsvBatch {
  key: string;
  productSlug: string;
  rows: DemoCsvReview[];
}

export const CSV_REVIEW_BATCHES: DemoCsvBatch[] = [
  {
    key: "csv-camaudit",
    productSlug: PRODUCT_SLUGS.camaudit,
    rows: [
      {
        authorName: "P. Novak",
        body: "The base-year comparison view saved our lease admin team hours every quarter.",
        rating: 5,
      },
      {
        authorName: "M. Ibrahim",
        body: "Solid product overall; onboarding a new portfolio still takes longer than we'd like.",
        rating: 4,
      },
    ],
  },
  {
    key: "csv-grantpipe",
    productSlug: PRODUCT_SLUGS.grantpipe,
    rows: [
      {
        authorName: "C. Halvorsen",
        body: "Our reviewers finally have one place to leave notes instead of five email threads.",
        rating: 4,
      },
    ],
  },
];

export interface DemoSqlReview {
  key: string;
  productSlug: string;
  source: "rss" | "g2" | "trustpilot";
  externalId: string;
  body: string;
  authorName: string | null;
  rating: number | null;
  sourceUrl: string | null;
  importedAtHours: number;
}

export const SQL_REVIEWS: DemoSqlReview[] = [
  // rss (3)
  {
    key: "rss1",
    productSlug: PRODUCT_SLUGS.camaudit,
    source: "rss",
    externalId: "demo-rss-camaudit-01",
    body: "Camaudit shipped a public changelog entry this week covering the new gross-up detection rule.",
    authorName: "Camaudit Changelog",
    rating: null,
    sourceUrl: "https://camaudit.io/changelog/demo-rss-camaudit-01",
    importedAtHours: -24 * 32,
  },
  {
    key: "rss2",
    productSlug: PRODUCT_SLUGS.grantpipe,
    source: "rss",
    externalId: "demo-rss-grantpipe-01",
    body: "GrantPipe's blog covered how three regional nonprofits consolidated their grant calendars.",
    authorName: "GrantPipe Blog",
    rating: null,
    sourceUrl: "https://grantpipe.com/blog/demo-rss-grantpipe-01",
    importedAtHours: -24 * 28,
  },
  {
    key: "rss3",
    productSlug: PRODUCT_SLUGS.crm,
    source: "rss",
    externalId: "demo-rss-crm-01",
    body: "Ventora CRM's release notes feed mentioned the new feedback-button widget going live.",
    authorName: "Ventora CRM Release Notes",
    rating: null,
    sourceUrl: "https://crm.ventoralabs.com/changelog/demo-rss-crm-01",
    importedAtHours: -24 * 24,
  },
  // g2 (3)
  {
    key: "g2-1",
    productSlug: PRODUCT_SLUGS.camaudit,
    source: "g2",
    externalId: "demo-g2-camaudit-01",
    body: "Best-in-class CAM reconciliation tooling for our commercial real estate portfolio.",
    authorName: "Verified G2 Reviewer",
    rating: 5,
    sourceUrl: "https://www.g2.com/products/camaudit/reviews/demo-g2-camaudit-01",
    importedAtHours: -24 * 33,
  },
  {
    key: "g2-2",
    productSlug: PRODUCT_SLUGS.camaudit,
    source: "g2",
    externalId: "demo-g2-camaudit-02",
    body: "Strong detection accuracy; the learning curve for new team members is a bit steep.",
    authorName: "Verified G2 Reviewer",
    rating: 4,
    sourceUrl: "https://www.g2.com/products/camaudit/reviews/demo-g2-camaudit-02",
    importedAtHours: -24 * 29,
  },
  {
    key: "g2-3",
    productSlug: PRODUCT_SLUGS.grantpipe,
    source: "g2",
    externalId: "demo-g2-grantpipe-01",
    body: "GrantPipe's pipeline view is the reason our team finally hit every submission deadline last cycle.",
    authorName: "Verified G2 Reviewer",
    rating: 5,
    sourceUrl: "https://www.g2.com/products/grantpipe/reviews/demo-g2-grantpipe-01",
    importedAtHours: -24 * 25,
  },
  // trustpilot (3)
  {
    key: "tp-1",
    productSlug: PRODUCT_SLUGS.camaudit,
    source: "trustpilot",
    externalId: "demo-tp-camaudit-01",
    body: "Great support team, walked us through our first reconciliation end to end.",
    authorName: "Trustpilot Reviewer",
    rating: 5,
    sourceUrl: "https://www.trustpilot.com/reviews/demo-tp-camaudit-01",
    importedAtHours: -24 * 31,
  },
  {
    key: "tp-2",
    productSlug: PRODUCT_SLUGS.grantpipe,
    source: "trustpilot",
    externalId: "demo-tp-grantpipe-01",
    body: "Does what it says. Reporting exports could use more formatting options.",
    authorName: "Trustpilot Reviewer",
    rating: 3,
    sourceUrl: "https://www.trustpilot.com/reviews/demo-tp-grantpipe-01",
    importedAtHours: -24 * 27,
  },
  {
    key: "tp-3",
    productSlug: PRODUCT_SLUGS.crm,
    source: "trustpilot",
    externalId: "demo-tp-crm-01",
    body: "Set up the Wall of Fame widget on our site in one afternoon. Exactly as advertised.",
    authorName: "Trustpilot Reviewer",
    rating: 5,
    sourceUrl: "https://www.trustpilot.com/reviews/demo-tp-crm-01",
    importedAtHours: -24 * 23,
  },
];

// ---------------------------------------------------------------------------
// Connector configs (3): one ok, one error, one never-polled.
// ---------------------------------------------------------------------------

export interface DemoConnectorConfig {
  key: string;
  productSlug: string;
  source: "rss" | "g2" | "trustpilot";
  config: Record<string, string>;
  enabled: boolean;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  lastInsertedAt: number | null;
  lastPolledAtHours: number | null;
}

export const CONNECTOR_CONFIGS: DemoConnectorConfig[] = [
  {
    key: "cc-ok",
    productSlug: PRODUCT_SLUGS.camaudit,
    source: "rss",
    config: { feed_url: "https://camaudit.io/changelog/feed.xml", review_source: "rss" },
    enabled: true,
    lastStatus: "ok",
    lastError: null,
    lastInsertedAt: 1,
    lastPolledAtHours: -6,
  },
  {
    key: "cc-error",
    productSlug: PRODUCT_SLUGS.grantpipe,
    source: "g2",
    config: { product_slug: "grantpipe" },
    enabled: true,
    lastStatus: "error",
    lastError: "HTTP 403 fetching G2 reviews page — request was blocked.",
    lastInsertedAt: 0,
    lastPolledAtHours: -6,
  },
  {
    key: "cc-never",
    productSlug: PRODUCT_SLUGS.crm,
    source: "trustpilot",
    config: { business_unit_id: "ventoralabs.com" },
    enabled: true,
    lastStatus: null,
    lastError: null,
    lastInsertedAt: null,
    lastPolledAtHours: null,
  },
];
