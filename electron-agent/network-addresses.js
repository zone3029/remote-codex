const os = require('node:os');

const EXCLUDED_INTERFACE = /(?:loopback|docker|veth|vmware|virtualbox|hyper-v|vethernet|tailscale|wireguard|tunnel|vpn|zerotier)/i;

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function privateIpv4Addresses(interfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (EXCLUDED_INTERFACE.test(name)) continue;
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : String(entry.family));
      if (family !== 'IPv4' || entry.internal || !isPrivateIpv4(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort().slice(0, 8);
}

module.exports = { isPrivateIpv4, privateIpv4Addresses };
