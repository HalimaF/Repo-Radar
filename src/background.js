// Clicking the toolbar icon opens the side panel; the panel itself tracks the active tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
