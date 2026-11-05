"""UI setup for BamLabs Family Hub."""
from homeassistant import config_entries
from .const import DOMAIN, TITLE


class FamilyHubConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create one local Family Hub instance."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title=TITLE, data={})
