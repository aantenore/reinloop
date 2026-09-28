---
pattern: router
description: Sends each request to the right specialist
roles:
  router:
    instructions: You classify engineering requests.
    params: { temperature: 0 }
  routes: [ship, explainer]
options: { fallback: explainer }
---
