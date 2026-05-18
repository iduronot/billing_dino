const snmp = require('net-snmp');
const axios = require('axios');
const qs = require('qs');

/**
 * Hioso OLT Engine - Optimized for Fast Parallel Polling
 */
class HiosoOLT {
    constructor(host, community = 'public', port = 161) {
        this.host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        this.community = community;
        this.port = port;
        this.session = null;

        this.oid_profiles = {
            'HIOSO_C': { 
                'name':     '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
                'status':   '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
                'tx':       '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
                'rx':       '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
                'mac':      '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
                'vlan_pvid':'1.3.6.1.4.1.25355.3.2.6.5.1.1.2',
                'divider':  1
            },
            'HIOSO_B': { 
                'name':   '1.3.6.1.4.1.3320.101.10.1.1.79',
                'status': '1.3.6.1.4.1.3320.101.10.1.1.26',
                'tx':     '1.3.6.1.4.1.3320.101.10.5.1.5',
                'rx':     '1.3.6.1.4.1.3320.101.10.5.1.6',
                'mac':    '1.3.6.1.4.1.3320.101.10.1.1.3',
                'divider': 10
            },
            'HIOSO_GPON': { 
                'name':     '1.3.6.1.4.1.25355.3.3.1.1.1.2',
                'status':   '1.3.6.1.4.1.25355.3.3.1.1.1.11',
                'tx':       '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
                'rx':       '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
                'mac':      '1.3.6.1.4.1.25355.3.3.1.1.1.5',
                'vlan_pvid':'1.3.6.1.4.1.25355.3.3.1.2.2.1.2',
                'divider':  100
            },
            'ZTE': { 
                'name':   '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
                'sn':     '1.3.6.1.4.1.3902.1012.3.28.1.1.5',
                'status': '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
                'tx':     '1.3.6.1.4.1.3902.1012.3.50.12.1.1.9',
                'rx':     '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10',
                'mac':    '1.3.6.1.4.1.3902.1012.3.28.1.1.5',
                'divider': 'zte'
            },
            // ============================================================
            // HSGQ enterprise OID = 50224 (HSGQ-G02ID, sysObjectID .50224.3.1.1)
            // Nama ONU: .3.12.2.1.2 → index format: INDEX (e.g. 16777472)
            // Signal:   .3.12.3.1.x → index format: INDEX.0.0
            // Catatan:  index signal dinormalisasi (strip .0.0) agar cocok dengan nama.
            //           Entry .INDEX.65535.65535 adalah alarm threshold, dilewati.
            // Status:   tidak ada OID khusus, diturunkan dari ada/tidaknya data RX.
            // Divider:  'hsgq' = RX negatif ÷100, TX positif ÷1000
            //   Contoh: -2100 ÷ 100 = -21.00 dBm (RX) ✓
            //           4273  ÷ 1000 = 4.273 dBm  (TX) ✓
            // ============================================================
            'HSGQ': {
                'name':    '1.3.6.1.4.1.50224.3.12.2.1.2',
                'rx':      '1.3.6.1.4.1.50224.3.12.3.1.4',
                'tx':      '1.3.6.1.4.1.50224.3.12.3.1.8',
                'divider': 'hsgq'
            },
            'HSGQ_GPON': {
                'name':   '1.3.6.1.4.1.55047.1.3.2.1.2.1.5',
                'status': '1.3.6.1.4.1.55047.1.3.2.1.2.1.13',
                'tx':     '1.3.6.1.4.1.55047.1.3.2.1.2.1.19',
                'rx':     '1.3.6.1.4.1.55047.1.3.2.1.2.1.20',
                'mac':    '1.3.6.1.4.1.55047.1.3.2.1.2.1.2',
                'divider': 100
            },
            'HIOSO_HA73': {
                'name':   '1.3.6.1.4.1.34592.1.3.100.12.1.1.2',
                'status': '1.3.6.1.4.1.34592.1.3.100.12.1.1.5',
                'tx':     '1.3.6.1.4.1.34592.1.3.100.12.1.1.13',
                'rx':     '1.3.6.1.4.1.34592.1.3.100.12.1.1.14',
                'mac':    '1.3.6.1.4.1.34592.1.3.100.12.1.1.12',
                'divider': 10
            },
            'Huawei': {
                'name':   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
                'status': '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.10',
                'tx':     '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.3',
                'rx':     '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4',
                'mac':    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.1',
                'sn':     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
                'divider': 100
            },
        };
    }

    async getOnuList(cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, 
            version: snmp.Version2c, 
            timeout: 10000, 
            retries: 3,
            maxRepetitions: 20
        });

        try {
            let activeProfile = this.oid_profiles[cachedProfileName] || null;

            if (!activeProfile) {
                console.log(`[OLT SYNC] Profile "${cachedProfileName}" tidak dikenali, mulai auto-probe...`);
                for (const [pName, pMap] of Object.entries(this.oid_profiles)) {
                    try {
                        const isMatch = await new Promise(resolve => {
                            this.session.getNext([pMap.name], (err, vbs) => {
                                if (!err && vbs[0]) {
                                    const cleanVbOid = vbs[0].oid.replace(/^\./, '').replace(/^iso\./, '1.');
                                    const cleanPMapName = pMap.name.replace(/^\./, '').replace(/^iso\./, '1.');
                                    if (cleanVbOid.startsWith(cleanPMapName)) resolve(true);
                                    else resolve(false);
                                } else resolve(false);
                            });
                        });
                        if (isMatch) { activeProfile = { ...pMap, pName }; break; }
                    } catch (e) {}
                }
            } else {
                activeProfile = { ...activeProfile, pName: cachedProfileName };
                console.log(`[OLT SYNC] Menggunakan cached profile: ${cachedProfileName}`);
            }

            if (!activeProfile) throw new Error("Gagal mendeteksi profil OLT. Pastikan community string dan host benar.");

            console.log(`[OLT SYNC] Active Profile: ${activeProfile.pName}`);

            const activeOIDs = {};
            ['name', 'status', 'tx', 'rx', 'mac', 'sn'].forEach(k => { 
                if (activeProfile[k]) activeOIDs[k] = activeProfile[k].replace(/^\./, '').replace(/^iso\./, '1.'); 
            });

            const extractIdx = (rawOid, baseOid) => {
                if (!rawOid || !baseOid) return '';
                const r = rawOid.replace(/^\./, '').replace(/^iso\./, '1.');
                const b = baseOid.replace(/^\./, '').replace(/^iso\./, '1.');
                if (r.startsWith(b)) return r.substring(b.length).replace(/^\./, '');
                const parts = r.split('.');
                return parts.slice(-2).join('.');
            };

            const parseSignal = (val) => {
                let num = parseFloat(val);
                if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                if (activeProfile.divider === 'zte') return ((num - 15000) / 500).toFixed(2);
                // HSGQ: RX negatif ÷100, TX positif ÷1000
                if (activeProfile.divider === 'hsgq') {
                    return num < 0 ? (num / 100).toFixed(2) : (num / 1000).toFixed(2);
                }
                const div = activeProfile.divider || 1;
                if (Math.abs(num) > 500 && div === 1) return (num / 100).toFixed(2);
                return (num / div).toFixed(2);
            };

            const formatMac = (val) => {
                if (!val) return '';
                if (Buffer.isBuffer(val)) {
                    if (val.length === 6) return Array.from(val).map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
                    const s = val.toString().trim();
                    if (/^[0-9A-Fa-f]{12}$/.test(s)) return s.match(/.{2}/g).join(':').toUpperCase();
                    return s.toUpperCase();
                }
                return val.toString().trim().toUpperCase();
            };

            const categories = Object.keys(activeOIDs);
            const dataStore = {};
            categories.forEach(c => dataStore[c] = {});

            const isHsgq = activeProfile.pName === 'HSGQ';

            const runMultiWalk = async () => {
                let currentPointers = categories.map(c => activeOIDs[c]);
                let finished = new Array(categories.length).fill(false);

                while (finished.includes(false)) {
                    const toFetch = currentPointers.filter((_, i) => !finished[i]);
                    const fetchIndices = categories.map((_, i) => i).filter(i => !finished[i]);
                    if (toFetch.length === 0) break;

                    const vbs = await new Promise((resolve, reject) => {
                        this.session.getNext(toFetch, (err, vbs) => {
                            if (err) return reject(err);
                            resolve(vbs);
                        });
                    });

                    for (let i = 0; i < fetchIndices.length; i++) {
                        const catIdx = fetchIndices[i];
                        const vb = vbs[i];
                        if (!vb || !vb.oid || snmp.isVarbindError(vb)) { finished[catIdx] = true; continue; }
                        
                        const cleanOid = vb.oid.replace(/^\./, '').replace(/^iso\./, '1.');
                        const baseOid = activeOIDs[categories[catIdx]];
                        
                        if (cleanOid.startsWith(baseOid)) {
                            let idx = extractIdx(cleanOid, baseOid);

                            // HSGQ: signal OIDs pakai INDEX.0.0 (actual) dan INDEX.65535.65535 (alarm)
                            // Lewati entry alarm, normalisasi entry actual ke INDEX biasa
                            if (isHsgq) {
                                if (idx.endsWith('.65535.65535')) {
                                    // Lewati alarm threshold, tapi tetap advance pointer
                                    currentPointers[catIdx] = cleanOid;
                                    continue;
                                }
                                if (idx.endsWith('.0.0')) {
                                    idx = idx.slice(0, -4); // "16777472.0.0" → "16777472"
                                }
                            }

                            dataStore[categories[catIdx]][idx] = vb.value;
                            currentPointers[catIdx] = cleanOid;
                        } else {
                            finished[catIdx] = true;
                        }
                    }
                }
            };

            await runMultiWalk();

            console.log(`[OLT SYNC] Walk selesai. Entry per OID:`,
                Object.fromEntries(categories.map(c => [c, Object.keys(dataStore[c]).length]))
            );

            const onus = [];

            for (const [idx, rawName] of Object.entries(dataStore.name)) {
                const name = rawName.toString().replace(/[^\x20-\x7E]/g, '').trim();
                if (!name || ['public', 'internal', 'private'].some(s => name.toLowerCase().includes(s))) continue;

                let status = 'Down';

                if (isHsgq) {
                    // HSGQ tidak punya OID status khusus per-ONU.
                    // Status diturunkan: jika ada data RX yang valid → Up, jika tidak → Down.
                    const rxRaw = dataStore.rx ? dataStore.rx[idx] : undefined;
                    status = (rxRaw !== undefined && parseInt(rxRaw) > -4000) ? 'Up' : 'Down';
                } else {
                    const isGPON = ['HIOSO_GPON', 'HSGQ_GPON'].includes(activeProfile.pName)
                        || activeProfile.name.includes('.25355.3.3')
                        || activeProfile.name.includes('.55047.1.3');
                    const sVal = dataStore.status ? dataStore.status[idx] : undefined;
                    if (sVal !== undefined) {
                        const v = parseInt(sVal);
                        if (activeProfile.pName === 'ZTE') {
                            status = (v === 3) ? 'Up' : 'Down';
                        } else if (activeProfile.pName === 'HSGQ_GPON') {
                            status = (v === 1) ? 'Up' : 'Down';
                        } else if (isGPON) {
                            status = (v >= 2 && v <= 4) ? 'Up' : 'Down';
                        } else {
                            status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                        }
                    }
                }

                onus.push({
                    index: idx, name, status,
                    tx_power: parseSignal(dataStore.tx ? dataStore.tx[idx] : undefined),
                    rx_power: parseSignal(dataStore.rx ? dataStore.rx[idx] : undefined),
                    sn: dataStore.sn ? (dataStore.sn[idx] || '').toString() : '',
                    mac: dataStore.mac ? formatMac(dataStore.mac[idx]) : ''
                });
            }

            console.log(`[OLT SYNC] Total ONU: ${onus.length}`);
            return { onus, detectedProfile: activeProfile.pName };
        } finally {
            if (this.session) this.session.close();
        }
    }

    async getOnuData(index, cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 
        });
        try {
            let pMap = this.oid_profiles[cachedProfileName || 'HIOSO_C'];

            // HSGQ: signal OID pakai INDEX.0.0 bukan INDEX
            const idxSuffix = (cachedProfileName === 'HSGQ') ? '.0.0' : '';
            const oids = pMap.status
                ? [pMap.status + '.' + index + idxSuffix, pMap.tx + '.' + index + idxSuffix, pMap.rx + '.' + index + idxSuffix]
                : [pMap.tx + '.' + index + idxSuffix, pMap.rx + '.' + index + idxSuffix];

            return new Promise((resolve, reject) => {
                this.session.get(oids, (error, varbinds) => {
                    if (error) return reject(error);
                    const data = { status: 'Down', tx_power: '0.00', rx_power: '0.00' };

                    const parseSignal = (val) => {
                        let num = parseFloat(val);
                        if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                        if (pMap.divider === 'zte') return ((num - 15000) / 500).toFixed(2);
                        if (pMap.divider === 'hsgq') return num < 0 ? (num / 100).toFixed(2) : (num / 1000).toFixed(2);
                        return (num / (pMap.divider || 1)).toFixed(2);
                    };

                    if (cachedProfileName === 'HSGQ') {
                        // HSGQ: tidak ada status OID, gunakan TX/RX untuk deteksi online
                        const txVal = varbinds[0] && !snmp.isVarbindError(varbinds[0]) ? parseSignal(varbinds[0].value) : '0.00';
                        const rxVal = varbinds[1] && !snmp.isVarbindError(varbinds[1]) ? parseSignal(varbinds[1].value) : '0.00';
                        data.tx_power = txVal;
                        data.rx_power = rxVal;
                        data.status = (parseFloat(rxVal) < 0) ? 'Up' : 'Down';
                    } else {
                        if (varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
                            const v = parseInt(varbinds[0].value);
                            if (cachedProfileName === 'ZTE') {
                                data.status = (v === 3) ? 'Up' : 'Down';
                            } else if (cachedProfileName === 'HSGQ_GPON') {
                                data.status = (v === 1) ? 'Up' : 'Down';
                            } else {
                                data.status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                            }
                        }
                        if (varbinds[1] && !snmp.isVarbindError(varbinds[1])) data.tx_power = parseSignal(varbinds[1].value);
                        if (varbinds[2] && !snmp.isVarbindError(varbinds[2])) data.rx_power = parseSignal(varbinds[2].value);
                    }

                    resolve(data);
                });
            });
        } finally {
            if (this.session) this.session.close();
        }
    }

    /**
     * Discovery tool: Walk sub-tree untuk debug OID.
     * Endpoint: POST /olt/api/snmpwalk-discovery
     */
    async discoverOids(subtreeOid, maxEntries = 40) {
        this.session = snmp.createSession(this.host, this.community, {
            port: this.port, version: snmp.Version2c, timeout: 8000, retries: 2
        });
        const results = [];
        let currentOid = subtreeOid;
        try {
            while (results.length < maxEntries) {
                const vbs = await new Promise((resolve, reject) => {
                    this.session.getNext([currentOid], (err, vbs) => {
                        if (err) return reject(err);
                        resolve(vbs);
                    });
                });
                const vb = vbs[0];
                if (!vb || !vb.oid || snmp.isVarbindError(vb)) break;
                const cleanOid = vb.oid.replace(/^\./, '').replace(/^iso\./, '1.');
                if (!cleanOid.startsWith(subtreeOid)) break;
                let valStr = '';
                if (Buffer.isBuffer(vb.value)) {
                    valStr = `[Buffer hex: ${vb.value.toString('hex')} | text: "${vb.value.toString().replace(/[^\x20-\x7E]/g, '?')}"]`;
                } else {
                    valStr = String(vb.value);
                }
                results.push({ oid: cleanOid, value: valStr, type: vb.type });
                currentOid = cleanOid;
            }
            return results;
        } finally {
            if (this.session) this.session.close();
        }
    }

    async rebootOnu(index, user, pass) {
        const baseUrl = `http://${this.host}`;
        try {
            const login = await axios.post(`${baseUrl}/goform/login`, qs.stringify({
                user, pass, username: user, password: pass, submit: 'Login'
            }), { timeout: 5000, validateStatus: false });
            const cookie = (login.headers['set-cookie'] && login.headers['set-cookie'][0]) ? login.headers['set-cookie'][0] : '';
            const res = await axios.post(`${baseUrl}/goform/setOnu`, qs.stringify({
                index, action: 'reboot', terminal_id: index
            }), { headers: { Cookie: cookie }, timeout: 10000 });
            return res.status === 200;
        } catch (e) {
            return false;
        }
    }

    async setOnuVlan(index, vlanId, profileName) {
        this.session = snmp.createSession(this.host, this.community, { port: this.port, version: snmp.Version2c });
        try {
            let pMap = this.oid_profiles[profileName];
            if (!pMap || !pMap.vlan_pvid) throw new Error("Profil OLT ini tidak mendukung setting VLAN via SNMP.");
            const oid = pMap.vlan_pvid + '.' + index + '.1';
            const varbinds = [{ oid: oid, type: snmp.Type.Integer, value: parseInt(vlanId) }];
            return new Promise((resolve, reject) => {
                this.session.set(varbinds, (error, varbinds) => {
                    if (error) return reject(error);
                    resolve(true);
                });
            });
        } finally {
            if (this.session) this.session.close();
        }
    }

    async walk(oid) {
        this.session = snmp.createSession(this.host, this.community, { port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 });
        return new Promise((resolve, reject) => {
            this.session.get([oid], (error, varbinds) => {
                this.session.close();
                if (error) return reject(error);
                resolve(varbinds);
            });
        });
    }
}

module.exports = HiosoOLT;
