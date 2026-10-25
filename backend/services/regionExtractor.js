const PROVINCE_CENTROIDS = {
  ACEH:    { name: 'Aceh',                   lat:  4.695, lng:  96.749 },
  SUMUT:   { name: 'Sumatera Utara',          lat:  2.117, lng:  99.539 },
  SUMBAR:  { name: 'Sumatera Barat',          lat: -0.739, lng: 100.723 },
  RIAU:    { name: 'Riau',                    lat:  0.293, lng: 101.706 },
  KEPRI:   { name: 'Kepulauan Riau',          lat:  3.946, lng: 108.142 },
  JAMBI:   { name: 'Jambi',                   lat: -1.611, lng: 103.612 },
  SUMSEL:  { name: 'Sumatera Selatan',        lat: -3.319, lng: 104.914 },
  BABEL:   { name: 'Bangka Belitung',         lat: -2.741, lng: 106.440 },
  BENGKULU:{ name: 'Bengkulu',                lat: -3.794, lng: 102.260 },
  LAMPUNG: { name: 'Lampung',                 lat: -4.558, lng: 105.407 },
  DKI:     { name: 'DKI Jakarta',             lat: -6.212, lng: 106.845 },
  JABAR:   { name: 'Jawa Barat',              lat: -6.889, lng: 107.641 },
  BANTEN:  { name: 'Banten',                  lat: -6.406, lng: 106.065 },
  JATENG:  { name: 'Jawa Tengah',             lat: -7.151, lng: 110.140 },
  DIY:     { name: 'DI Yogyakarta',           lat: -7.880, lng: 110.367 },
  JATIM:   { name: 'Jawa Timur',              lat: -7.536, lng: 112.238 },
  BALI:    { name: 'Bali',                    lat: -8.410, lng: 115.189 },
  NTB:     { name: 'Nusa Tenggara Barat',     lat: -8.653, lng: 117.361 },
  NTT:     { name: 'Nusa Tenggara Timur',     lat: -8.657, lng: 121.079 },
  KALBAR:  { name: 'Kalimantan Barat',        lat: -0.139, lng: 111.013 },
  KALTENG: { name: 'Kalimantan Tengah',       lat: -2.214, lng: 113.917 },
  KALSEL:  { name: 'Kalimantan Selatan',      lat: -3.093, lng: 115.284 },
  KALTIM:  { name: 'Kalimantan Timur',        lat:  0.539, lng: 116.419 },
  KALTARA: { name: 'Kalimantan Utara',        lat:  3.070, lng: 116.042 },
  SULUT:   { name: 'Sulawesi Utara',          lat:  0.625, lng: 123.975 },
  GORONTALO:{ name: 'Gorontalo',              lat:  0.694, lng: 122.447 },
  SULTENG: { name: 'Sulawesi Tengah',         lat: -1.430, lng: 121.446 },
  SULBAR:  { name: 'Sulawesi Barat',          lat: -2.840, lng: 119.238 },
  SULSEL:  { name: 'Sulawesi Selatan',        lat: -3.660, lng: 120.063 },
  SULTRA:  { name: 'Sulawesi Tenggara',       lat: -4.145, lng: 122.174 },
  MALUKU:  { name: 'Maluku',                  lat: -3.238, lng: 130.145 },
  MALUT:   { name: 'Maluku Utara',            lat:  1.571, lng: 127.809 },
  PAPUA:   { name: 'Papua',                   lat: -4.270, lng: 138.080 },
  PABAR:   { name: 'Papua Barat',             lat: -1.337, lng: 133.175 },
};

const K3I_PATH_PATTERNS = [
  [/\/K3i\/ACEH\//i,    'ACEH'],
  [/\/K3i\/SUMUT\//i,   'SUMUT'],
  [/\/K3i\/SUMBAR\//i,  'SUMBAR'],
  [/\/K3i\/RIAU\//i,    'RIAU'],
  [/\/K3i\/KEPRI\//i,   'KEPRI'],
  [/\/K3i\/JAMBI\//i,   'JAMBI'],
  [/\/K3i\/SUMSEL\//i,  'SUMSEL'],
  [/\/K3i\/BABEL\//i,   'BABEL'],
  [/\/K3i\/BENGKULU\//i,'BENGKULU'],
  [/\/K3i\/LAMPUNG\//i, 'LAMPUNG'],
  [/\/K3i\/DKI\//i,     'DKI'],
  [/\/K3i\/JABAR\//i,   'JABAR'],
  [/\/K3i\/BANTEN\//i,  'BANTEN'],
  [/\/K3i\/JATENG\//i,  'JATENG'],
  [/\/K3i\/DIY\//i,     'DIY'],
  [/\/K3i\/JATIM\//i,   'JATIM'],
  [/\/K3i\/BALI\//i,    'BALI'],
  [/\/K3i\/NTB\//i,     'NTB'],
  [/\/K3i\/NTT\//i,     'NTT'],
  [/\/K3i\/KALBAR\//i,  'KALBAR'],
  [/\/K3i\/KALTENG\//i, 'KALTENG'],
  [/\/K3i\/KALSEL\//i,  'KALSEL'],
  [/\/K3i\/KALTIM\//i,  'KALTIM'],
  [/\/K3i\/KALTARA\//i, 'KALTARA'],
  [/\/K3i\/SULUT\//i,   'SULUT'],
  [/\/K3i\/SULTENG\//i, 'SULTENG'],
  [/\/K3i\/SULBAR\//i,  'SULBAR'],
  [/\/K3i\/SULSEL\//i,  'SULSEL'],
  [/\/K3i\/SULTRA\//i,  'SULTRA'],
  [/\/K3i\/MALUKU\//i,  'MALUKU'],
  [/\/K3i\/MALUT\//i,   'MALUT'],
  [/\/K3i\/PAPUA\//i,   'PAPUA'],
  [/\/K3i\/PABAR\//i,   'PABAR'],
  // 2RTMC-2TMC subdirectory with province prefix
  [/SUMUT-\d/i,  'SUMUT'],
  [/JABAR-\d/i,  'JABAR'],
  [/JATIM-\d/i,  'JATIM'],
  [/JATENG-\d/i, 'JATENG'],
  [/DKI-\d/i,    'DKI'],
  [/BALI-\d/i,   'BALI'],
  [/DIY-\d/i,    'DIY'],
  [/BANTEN-\d/i, 'BANTEN'],
  [/SULSEL-\d/i, 'SULSEL'],
  [/RIAU-\d/i,   'RIAU'],
  [/LAMPUNG-\d/i,'LAMPUNG'],
  [/KALSEL-\d/i, 'KALSEL'],
  [/NTB-\d/i,    'NTB'],
];

const HOST_PROVINCE_MAP = {
  'nganjukkab.go.id':                    'JATIM',
  'wxyz.nganjukkab.go.id':               'JATIM',
  'mojokertokab.go.id':                  'JATIM',
  'dishubstreaming.mojokertokab.go.id':  'JATIM',
  'stream.batukota.go.id':               'JATIM',
  'batukota.go.id':                      'JATIM',
  'jmlive.jasamarga.com':                'JABAR', // Mostly Jakarta-West Java corridor
  'vms.k3i-korlantas.id':                null,     // Determined by URL path
};

// Seeded pseudo-random offset so coordinates are deterministic per camera
function seededOffset(seed, scale = 0.3) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  const r1 = ((h & 0xffff) / 0xffff - 0.5) * scale;
  const r2 = (((h >> 16) & 0xffff) / 0xffff - 0.5) * scale;
  return { dLat: r1, dLng: r2 };
}

function extractRegion(camera) {
  const link = camera.link || '';
  const host = (camera.host || '').toLowerCase();

  // 1. K3I path-based detection
  for (const [pattern, code] of K3I_PATH_PATTERNS) {
    if (pattern.test(link)) {
      const province = PROVINCE_CENTROIDS[code];
      if (province) {
        const offset = seededOffset(camera.id || link);
        return {
          provinceCode: code,
          provinceName: province.name,
          lat: province.lat + offset.dLat,
          lng: province.lng + offset.dLng,
        };
      }
    }
  }

  // 2. Host-based detection
  for (const [hostKey, code] of Object.entries(HOST_PROVINCE_MAP)) {
    if (host.includes(hostKey) && code) {
      const province = PROVINCE_CENTROIDS[code];
      if (province) {
        const offset = seededOffset(camera.id || link);
        return {
          provinceCode: code,
          provinceName: province.name,
          lat: province.lat + offset.dLat,
          lng: province.lng + offset.dLng,
        };
      }
    }
  }

  // 3. Jasa Marga Toll road cameras - roughly in West Java / Banten corridor
  if (host.includes('jasamarga')) {
    const code = 'JABAR';
    const province = PROVINCE_CENTROIDS[code];
    const offset = seededOffset(camera.id || link);
    return {
      provinceCode: code,
      provinceName: province.name,
      lat: province.lat + offset.dLat,
      lng: province.lng + offset.dLng,
    };
  }

  // 4. Default: center of Java
  const offset = seededOffset(camera.id || link, 5.0);
  return {
    provinceCode: 'OTHER',
    provinceName: 'Tidak Diketahui',
    lat: -7.0 + offset.dLat * 0.1,
    lng: 110.0 + offset.dLng * 0.1,
  };
}

module.exports = { extractRegion, PROVINCE_CENTROIDS };
