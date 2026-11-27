# Payment acceptance

| Scenario | Result |
| --- | --- |
| UPI Standard Checkout using the previous key | Prior hosted private acceptance reached the live UPI overlay. The provider API reported one ₹12 INR UPI capture. The merchant order queue showed the corresponding pickup order as paid and completed. |
| COD and cash reconciliation | Local pickup, delivery, counter and rider cash tests passed. Existing hosted owner session showed a completed cash pickup. |
| Refresh, disconnect, retry and duplicate confirmation | Covered with simulated payments and signed events, including confirmation after the shopper disconnected and owner queue visibility. |
| Wrong totals, expired reservations, late captures and refund replay | Covered with simulated provider callbacks and local fixtures. |
| Actual provider webhook | On 27 November at 11:53:17 IST, a no-op using the previously saved secret returned HTTP 403 with the application's invalid-signature response. The Live Razorpay dashboard confirmed the receiver and six active events. Historical Worker logging was disabled and an authentic delivery attempt was unavailable in the inspected provider details. |
| Live refunds and cards | Live refund and checkout flags were disabled throughout this QA. Card checkout was outside the permitted UPI-only acceptance scope. |

Webhook endpoint is [the merchant Razorpay receiver](https://blink-it.pages.dev/api/webhooks/razorpay). Rotate the exposed Razorpay key, update the matching webhook secret together with the Worker configuration, inspect provider delivery attempts and reconcile the already-captured payment. A fresh real payment or refund needs separate authorization. [Razorpay webhook best practices](https://razorpay.com/docs/webhooks/best-practices)
