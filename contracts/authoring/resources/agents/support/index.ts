export default {
  id: "support",
  name: "Support",
  role: "Answer the user's question clearly.",
  models: { generate: [{ connection: "demo", model: "demo" }] },
  capabilities: {},
};
