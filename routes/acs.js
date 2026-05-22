const express = require('express');
const router = express.Router();
const axios = require('axios');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Helper to get ACS settings
async function getACSSettings() {
    const [rows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_vparams', 'acs_path_pppoe', 'acs_path_ip', 'acs_online_threshold')");
    const s = {};
    rows.forEach(r => s[r.setting_key] = r.setting_value);
    return s;
}

function getAxiosConfig(s) {
    return {
        timeout: 15000,
        auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined
    };
}

// GET /acs
router.get('/', async (req, res) => {
    try {
        const s = await getACSSettings();
        
        let devices = [];
        let acsOnline = false;
        const vParams = s.acs_vparams ? s.acs_vparams.split(/\r?\n/).filter(p => p.trim()) : [];
        const acsOnlineThreshold = parseInt(s.acs_online_threshold) || 15;  // menit
        const acsThresholdMs     = acsOnlineThreshold * 60 * 1000;
        
        if (s.acs_url) {
            try {
                // Combine default projection with virtual parameters and common paths
                let projection = '_id,_lastInform,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber';
                const commonPaths = [
                    s.acs_path_pppoe || 'VirtualParameters.PPPoEUser',
                    s.acs_path_ip || 'VirtualParameters.IPAddress',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
                ];
                
                projection += ',' + [...new Set(commonPaths)].join(',');
                if (vParams.length > 0) {
                    projection += ',' + vParams.join(',');
                }

                const response = await axios.get(`${s.acs_url}/devices`, {
                    ...getAxiosConfig(s),
                    params: { projection }
                });
                acsOnline = true;
                if (Array.isArray(response.data)) {
                    devices = response.data.map(d => {
                        // Helper to get value from nested path
                        const getVal = (path) => {
                            if (!path) return null;
                            const parts = path.split('.');
                            let val = d;
                            for (const part of parts) { 
                                val = (val && val[part]) ? val[part] : undefined; 
                            }
                            return (val && typeof val === 'object' && '_value' in val) ? val._value : val;
                        };

                        const device = {
                            id: d._id,
                            sn: (d._deviceId && d._deviceId._SerialNumber) ? d._deviceId._SerialNumber : d._id,
                            manufacturer: (d._deviceId && d._deviceId._Manufacturer) ? d._deviceId._Manufacturer : 'Unknown',
                            product_class: (d._deviceId && d._deviceId._ProductClass) ? d._deviceId._ProductClass : 'ONT',
                            last_inform: d._lastInform || null,
                            isOnline: d._lastInform ? (Date.now() - new Date(d._lastInform).getTime() < acsThresholdMs) : false,
                            pppoe_user: getVal(s.acs_path_pppoe) || getVal('VirtualParameters.PPPoEUser') || getVal('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username') || '-',
                            ip_address: getVal(s.acs_path_ip) || getVal('VirtualParameters.IPAddress') || getVal('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress') || '-',
                            vparams: {}
                        };
                        
                        // Extract additional virtual parameters
                        vParams.forEach(p => {
                            device.vparams[p] = getVal(p);
                        });
                        
                        return device;
                    });
                }
            } catch (err) {
                console.error("ACS API unreachable:", err.message);
            }
        }
        
        res.render('acs', { user: req.session, devices, acsOnline, acsUrl: s.acs_url || '', vParams, acsOnlineThreshold, currentPage: 'acs' });
    } catch (err) {
        console.error(err);
        res.render('acs', { user: req.session, devices: [], acsOnline: false, acsUrl: '', vParams: [], acsOnlineThreshold: 15, currentPage: 'acs' });
    }
});

// POST /acs/api/reboot/:deviceId — Reboot device
router.post('/api/reboot/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'reboot' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Perintah reboot dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// POST /acs/api/refresh/:deviceId — Refresh device parameters
router.post('/api/refresh/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'refreshObject', objectName: '' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Refresh parameter dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// POST /acs/api/factory-reset/:deviceId — Factory reset device
router.post('/api/factory-reset/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'factoryReset' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Factory reset dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// GET /acs/api/wifi/:deviceId — Fetch current WiFi SSID values
router.get('/api/wifi/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        // Accept optional custom paths via query, fallback to defaults
        const pathSsid24 = req.query.pathSsid24 || 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID';
        const pathPass24 = req.query.pathPass24 || 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey';
        const pathSsid5  = req.query.pathSsid5  || 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID';
        const pathPass5  = req.query.pathPass5  || 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey';

        // Also try alternate password paths (KeyPassphrase variant used by some vendors)
        const altPass24 = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase';
        const altPass5  = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase';

        const allPaths = [...new Set([pathSsid24, pathPass24, pathSsid5, pathPass5, altPass24, altPass5])];
        const projection = `_id,${allPaths.join(',')}`;

        const response = await axios.get(`${s.acs_url}/devices`, {
            ...getAxiosConfig(s),
            params: { query: JSON.stringify({ _id: deviceId }), projection }
        });

        if (!Array.isArray(response.data) || response.data.length === 0)
            return res.json({ success: false, message: 'Perangkat tidak ditemukan' });

        const d = response.data[0];
        const getVal = (path) => {
            const parts = path.split('.');
            let val = d;
            for (const part of parts) { val = (val && val[part]) ? val[part] : undefined; }
            return (val && typeof val === 'object' && '_value' in val) ? val._value : (val || '');
        };
        // Use first non-empty value between primary and alternate path
        const resolvePass = (primary, alt) => getVal(primary) || getVal(alt);

        res.json({
            success: true,
            ssid24: getVal(pathSsid24),
            pass24: resolvePass(pathPass24, altPass24),
            ssid5:  getVal(pathSsid5),
            pass5:  resolvePass(pathPass5, altPass5)
        });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// POST /acs/api/wifi/:deviceId — Set WiFi SSID / Password via setParameterValues
router.post('/api/wifi/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        const { params } = req.body; // [[path, value, xsdType], ...]

        if (!params || !Array.isArray(params) || params.length === 0)
            return res.json({ success: false, message: 'Tidak ada parameter yang dikirim' });

        // Basic path validation — only allow IGD WiFi paths
        for (const p of params) {
            if (!Array.isArray(p) || !p[0] || !p[1])
                return res.json({ success: false, message: 'Format parameter tidak valid' });
            if (!/^InternetGatewayDevice\.LANDevice\.\d+\.WLANConfiguration\.\d+\./i.test(p[0]))
                return res.json({ success: false, message: `Path tidak diizinkan: ${p[0]}` });
        }

        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            {
                name: 'setParameterValues',
                parameterValues: params.map(p => [p[0], p[1], p[2] || 'xsd:string'])
            },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: 'Konfigurasi WiFi berhasil dikirim ke perangkat.' });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? JSON.stringify(e.response.data) : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// DELETE /acs/api/device/:deviceId — Delete device from ACS
router.delete('/api/device/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.delete(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(s)
        );
        res.json({ success: true, message: `Device ${deviceId} dihapus dari ACS` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

module.exports = router;
