module.exports = [
  {
    type: "heading",
    defaultValue: "PebblePilot Settings",
  },
  {
    type: "text",
    defaultValue:
      "Save your Cursor API key and daemon connection here. " +
      "Settings are stored on the phone and the API key is sent to your home daemon.",
  },
  {
    type: "section",
    items: [
      {
        type: "heading",
        defaultValue: "Cursor",
      },
      {
        type: "input",
        messageKey: "CursorApiKey",
        label: "Cursor API key",
        description: "From cursor.com/dashboard → Integrations / API Keys",
      },
    ],
  },
  {
    type: "section",
    items: [
      {
        type: "heading",
        defaultValue: "Daemon",
      },
      {
        type: "input",
        messageKey: "DaemonUrl",
        defaultValue: "http://YOUR_LAN_OR_TAILSCALE_IP:8787",
        label: "Daemon URL",
        description: "LAN or Tailscale URL of the machine running pebblepilot (from your .env PEBBLEPILOT_LAN_HOST)",
      },
      {
        type: "input",
        messageKey: "DaemonToken",
        label: "Daemon token",
        description: "Must match PEBBLEPILOT_TOKEN in the daemon .env",
      },
    ],
  },
  {
    type: "submit",
    defaultValue: "Save Settings",
  },
];
