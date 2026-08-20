# Screenshots

The screenshots below show this system running against a local database seeded with **fictional**
companies and quotes (`npm run shots`). Acme, Globex, Initech, Umbrella, Wayne Enterprises,
Northwind, Stark, Hooli, Cyberdyne, Soylent, and Vandelay are placeholders; every address is
`@example.com`. No real customer data and no real testimonial appears anywhere in this repository.

Each image is captured by `tests/screenshots/`, not taken by hand: the orange banner is injected
by the harness, and every wait is a concrete locator rather than a sleep, so the set regenerates
identically. These 25 captures are the ones referenced from [`README.md`](../README.md) and this
file, so they live in [`screenshots/`](./screenshots/) alongside it; the remaining 8 that
`npm run shots` produces but nothing links to stay in
[`../docs/screenshots/`](../docs/screenshots/) as the raw archive.

---

### Admin

<table>
<tr>
<td>

![Admin overview: per-product readiness and the moderation queue](./screenshots/01-dashboard-overview.png)

Overview: per-product readiness and the moderation queue

</td>
<td>

![Customers list: lifecycle, linked products, merged from every source](./screenshots/02-customers-list.png)

Customers: lifecycle, linked products, merged from every source

</td>
</tr>
<tr>
<td>

![Customer detail drawer with the merged activity timeline](./screenshots/03-customer-detail-drawer.png)

Detail drawer: the activity timeline merges feedback, testimonials, and reviews

</td>
<td>

![Add customer sheet: name, email, company, role, social handles, lifecycle and notes. Linking a customer to a product happens separately, and that is where the firewall check runs](./screenshots/06-add-customer-sheet.png)

Create sheet: product links go through the firewall check

</td>
</tr>
</table>

### Wall of Fame

<table>
<tr>
<td>

![Wall of Fame pending queue, testimonials awaiting approval](./screenshots/07-wall-pending.png)

Pending queue: nothing reaches a widget before approval

</td>
<td>

![Wall of Fame approved list with starred entries](./screenshots/08-wall-approved.png)

Approved: starred entries are the ones `single-quote` will serve

</td>
</tr>
<tr valign="top">
<td>

<img src="./screenshots/09-testimonial-edit-drawer.png" width="224" alt="Testimonial edit drawer">

Edit drawer

</td>
<td>

![Wall of Fame empty state for a product with no approved content](./screenshots/11-wall-empty-floriva.png)

Empty state: a product with no approved content yet

</td>
</tr>
</table>

### Feedback and reviews

<table>
<tr>
<td>

![Feedback kanban board, six columns that scroll horizontally](./screenshots/12-feedback-kanban.png)

Six-column board (it scrolls horizontally)

</td>
<td>

![Feedback card mid-drag, driven by the keyboard sensor for a deterministic capture](./screenshots/13-feedback-mid-drag.png)

Mid-drag, driven by the keyboard sensor so the capture is deterministic

</td>
</tr>
<tr>
<td>

![CSV import mapping screen, headers inferred from a non-canonical file](./screenshots/16-reviews-csv-mapping.png)

CSV import: headers inferred from a non-canonical file

</td>
<td>

![Review connectors table showing all three poll states](./screenshots/18-reviews-connectors-table.png)

Scheduled connectors, showing all three poll states

</td>
</tr>
</table>

### Widgets

Rendered inside a Shadow DOM from the Worker's own HTML/CSS strings, shown here through
`/preview/*`.

<table>
<tr>
<td>

![wall-grid widget rendered in the preview sandbox](./screenshots/25-widget-wall-grid.png)

`wall-grid`

</td>
<td>

![wall-carousel widget, the same quotes clamped](./screenshots/26-widget-wall-carousel.png)

`wall-carousel`: the same quotes, clamped

</td>
</tr>
<tr>
<td>

![single-quote widget showing the featured testimonial only](./screenshots/27-widget-single-quote.png)

`single-quote`: featured only

</td>
<td>

![rating-badge widget showing the aggregate rating over approved entries](./screenshots/28-widget-rating-badge.png)

`rating-badge`: aggregate over approved entries

</td>
</tr>
<tr>
<td>

![feedback-button widget with its modal open](./screenshots/29-widget-feedback-button.png)

`feedback-button`, modal open

</td>
<td>

![wall-grid widget's deliberate empty state, reading "This widget is empty: the widget loaded correctly, there is just no approved content for Floriva yet"](./screenshots/30-widget-empty-floriva.png)

`wall-grid`, the deliberate empty state

</td>
</tr>
</table>

The five shots above go through `/preview/*`, an admin-only sandbox, so every one of them carries
the admin harness's banner. That is correct for a preview, but it understates what actually
ships: on a real customer page there is no banner, no admin chrome, nothing but the widget.

The two shots below are captured a different way, against
[`tests/fixtures/embed-sandbox.html`](../tests/fixtures/embed-sandbox.html), a plain static host
page with the production `<script data-product data-widget>` loader tag and nothing else, served
from an ordinary web origin against a local worker seeded with the same fictional dataset. This is
what `wall-grid` looks like dropped onto a third-party site.

<table>
<tr valign="top">
<td>

![wall-grid widget embedded on a plain host page via tests/fixtures/embed-sandbox.html, five fictional testimonials in a grid, no admin chrome or preview banner](./screenshots/34-widget-embed-live.png)

`wall-grid`, embedded on a plain host page, desktop width

</td>
<td>

<img src="./screenshots/35-widget-embed-live-mobile.png" width="220" alt="The same live embed at a 390px mobile width, testimonials stacked in a single column">

Same embed at mobile width

</td>
</tr>
</table>

### Settings and embedding

<table>
<tr valign="top">
<td>

![Settings: product table with masked widget keys, per-product colour, and origin counts, above a widget preview picker and the generated script tag](./screenshots/23-settings-embed-snippet.png)

Everything a product needs to embed: public widget key, origin allowlist, generated `<script>` tag

</td>
<td>

<img src="./screenshots/22-settings-edit-drawer.png" width="224" alt="Product edit drawer: origin allowlist entries and the widget key for one product">

Editing one product's origin allowlist

</td>
</tr>
</table>

### Responsive

<table>
<tr>
<td>

![Mobile admin overview](./screenshots/31-mobile-dashboard-overview.png)

Mobile admin overview

</td>
<td>

![Mobile customers list](./screenshots/32-mobile-customers-list.png)

Mobile customers list

</td>
<td>

![Mobile Wall of Fame approved view](./screenshots/33-mobile-wall-approved.png)

Mobile Wall of Fame approved view

</td>
</tr>
</table>

The full set (the 25 captures above plus the 8 that never made it into a write-up) is split
between [`screenshots/`](./screenshots/) and [`../docs/screenshots/`](../docs/screenshots/).

> There is no screenshot of a firewall rejection. The demo dataset has exactly one product in a
> firewall group, so no conflicting pair exists to trigger one, and inventing a second product
> purely to stage the error would make the image a prop rather than evidence. The rejection is
> demonstrated instead by `npm run verify:firewall`, which performs a real violating insert
> against a real database and asserts the abort.
