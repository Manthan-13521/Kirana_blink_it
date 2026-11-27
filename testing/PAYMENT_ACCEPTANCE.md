# Payment acceptance

| Scenario | Result |
| --- | --- |
| UPI Standard Checkout using the previous key | Prior hosted private acceptance reached the live UPI overlay. The provider API reported one ₹12 INR UPI capture. The merchant order queue showed the corresponding pickup order as paid and completed. |
| COD and cash reconciliation | Local pickup, delivery, counter and rider cash tests passed. Existing hosted owner session showed a completed cash pickup. |
| Refresh, disconnect, retry and duplicate confirmation | Covered with simulated payments and signed events, including confirmation after the shopper disconnected and owner queue visibility. |
| Wrong totals, expired reservations, late captures and refund replay | Covered with simulated provider callbacks and local fixtures. |
| Actual provider webhook | Razorpay Developers → Webhooks showed authentic `payment.captured` and `order.paid` at 11:07:28 IST on 27 November, both HTTP 200 for the configured endpoint. D1 had one Live capture at 11:07:27 IST and the order remained paid. The old-secret no-op at 11:53:17 IST returned HTTP 403. Provider delivery and the diagnostic are separate evidence. Fresh post-rotation delivery and an exact provider replay remain open. |
| Live refunds and cards | Live refund and checkout flags were disabled throughout this QA. Card checkout was outside the permitted UPI-only acceptance scope. |

Webhook endpoint is [the merchant Razorpay receiver](https://blink-it.pages.dev/api/webhooks/razorpay). Rotate the exposed Razorpay key, update the matching webhook secret together with the Worker configuration, inspect provider delivery attempts and reconcile the already-captured payment. A fresh real payment or refund needs separate authorization. [Razorpay webhook best practices](https://razorpay.com/docs/webhooks/best-practices)
