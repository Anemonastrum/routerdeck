export function initializeDatabase(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    os_type TEXT NOT NULL CHECK(os_type IN ('openwrt','mikrotik','generic','ruijie')),
    connection_mode TEXT NOT NULL DEFAULT 'ssh',
    rest_scheme TEXT DEFAULT 'https',
    rest_port INTEGER,
    monitor_interface TEXT,
    insecure_tls INTEGER NOT NULL DEFAULT 0,
    device_role TEXT NOT NULL DEFAULT 'client',
    detected_model TEXT DEFAULT '',
    credentials_enc TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_devices_host ON devices(host);

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    cpu REAL,
    memory_used INTEGER,
    memory_total INTEGER,
    uptime_sec INTEGER,
    rx_bytes INTEGER,
    tx_bytes INTEGER,
    clients_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_device_ts ON metrics(device_id, ts);

  CREATE TABLE IF NOT EXISTS uptime_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    status INTEGER NOT NULL,
    latency_ms REAL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_uptime_device_ts ON uptime_checks(device_id, ts);

  CREATE TABLE IF NOT EXISTS status_page_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    title TEXT NOT NULL DEFAULT 'Network Status',
    subtitle TEXT NOT NULL DEFAULT 'Live uptime status for monitored services and devices.',
    show_hosts INTEGER NOT NULL DEFAULT 0,
    refresh_seconds INTEGER NOT NULL DEFAULT 30,
    accent TEXT NOT NULL DEFAULT '#6f8cff',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    app_name TEXT NOT NULL DEFAULT 'RouterDeck',
    clock_format TEXT NOT NULL DEFAULT '24h' CHECK(clock_format IN ('12h','24h')),
    theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','latte','frappe','macchiato','mocha','amoled')),
    time_zone TEXT NOT NULL DEFAULT 'auto',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS network_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    service_type TEXT NOT NULL DEFAULT 'adguardhome' CHECK(service_type IN ('adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos')),
    host TEXT NOT NULL,
    scheme TEXT NOT NULL DEFAULT 'http' CHECK(scheme IN ('http','https')),
    port INTEGER,
    insecure_tls INTEGER NOT NULL DEFAULT 0,
    ssh_metrics INTEGER NOT NULL DEFAULT 0,
    credentials_enc TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_network_services_host ON network_services(host);

  CREATE TABLE IF NOT EXISTS service_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL REFERENCES network_services(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    status INTEGER NOT NULL,
    cpu REAL,
    memory_used INTEGER,
    memory_total INTEGER,
    protection_enabled INTEGER,
    version TEXT,
    extra_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_service_metrics_service_ts ON service_metrics(service_id, ts);

  CREATE TABLE IF NOT EXISTS service_uptime_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL REFERENCES network_services(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    status INTEGER NOT NULL,
    latency_ms REAL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_service_uptime_service_ts ON service_uptime_checks(service_id, ts);

  CREATE TABLE IF NOT EXISTS gateway_analytics_cache (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    bot_token_enc TEXT NOT NULL DEFAULT '',
    chat_id TEXT NOT NULL DEFAULT '',
    notify_down INTEGER NOT NULL DEFAULT 1,
    notify_up INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_down INTEGER NOT NULL DEFAULT 1,
    notify_up INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','selected')),
    device_ids_json TEXT NOT NULL DEFAULT '[]',
    service_ids_json TEXT NOT NULL DEFAULT '[]',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  `);

  // RouterDeck 1.4 adds Proxmox VE as a third managed network service.
  // Rebuild older service tables so their CHECK constraint accepts all current types.
  const servicesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_services'").get()?.sql || '';
  if (servicesSql && (!servicesSql.includes("'homeassistant'") || !servicesSql.includes("'proxmox'"))) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE network_services_v14 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        service_type TEXT NOT NULL DEFAULT 'adguardhome' CHECK(service_type IN ('adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos')),
        host TEXT NOT NULL,
        scheme TEXT NOT NULL DEFAULT 'http' CHECK(scheme IN ('http','https')),
        port INTEGER,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        ssh_metrics INTEGER NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO network_services_v14
        (id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at)
      SELECT id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at
      FROM network_services;
      DROP TABLE network_services;
      ALTER TABLE network_services_v14 RENAME TO network_services;
      CREATE INDEX idx_network_services_host ON network_services(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  // RouterDeck 1.7 adds Synology DSM as a managed network service.
  const servicesSqlV16 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_services'").get()?.sql || '';
  if (servicesSqlV16 && !servicesSqlV16.includes("'synology'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE network_services_v16 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        service_type TEXT NOT NULL DEFAULT 'adguardhome' CHECK(service_type IN ('adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos')),
        host TEXT NOT NULL,
        scheme TEXT NOT NULL DEFAULT 'http' CHECK(scheme IN ('http','https')),
        port INTEGER,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        ssh_metrics INTEGER NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO network_services_v16
        (id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at)
      SELECT id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at
      FROM network_services;
      DROP TABLE network_services;
      ALTER TABLE network_services_v16 RENAME TO network_services;
      CREATE INDEX idx_network_services_host ON network_services(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }


  // RouterDeck 1.12 adds Nginx Proxy Manager as a managed network service.
  const servicesSqlV112 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_services'").get()?.sql || '';
  if (servicesSqlV112 && !servicesSqlV112.includes("'nginxproxymanager'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE network_services_v112 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        service_type TEXT NOT NULL DEFAULT 'adguardhome' CHECK(service_type IN ('adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos')),
        host TEXT NOT NULL,
        scheme TEXT NOT NULL DEFAULT 'http' CHECK(scheme IN ('http','https')),
        port INTEGER,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        ssh_metrics INTEGER NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO network_services_v112
        (id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at)
      SELECT id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,created_at
      FROM network_services;
      DROP TABLE network_services;
      ALTER TABLE network_services_v112 RENAME TO network_services;
      CREATE INDEX idx_network_services_host ON network_services(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  // RouterDeck 1.15 adds CasaOS as a managed network service.
  const servicesSqlV115 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_services'").get()?.sql || '';
  if (servicesSqlV115 && !servicesSqlV115.includes("'casaos'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE network_services_v115 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        service_type TEXT NOT NULL DEFAULT 'adguardhome' CHECK(service_type IN ('adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos')),
        host TEXT NOT NULL,
        scheme TEXT NOT NULL DEFAULT 'http' CHECK(scheme IN ('http','https')),
        port INTEGER,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        ssh_metrics INTEGER NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO network_services_v115
        (id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,display_order,created_at)
      SELECT id,name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,display_order,created_at
      FROM network_services;
      DROP TABLE network_services;
      ALTER TABLE network_services_v115 RENAME TO network_services;
      CREATE INDEX idx_network_services_host ON network_services(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  const serviceColumnsV113 = db.prepare('PRAGMA table_info(network_services)').all().map(c => c.name);
  if (!serviceColumnsV113.includes('display_order')) db.exec("ALTER TABLE network_services ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");
  const serviceOrderRows = db.prepare('SELECT id, display_order, name FROM network_services ORDER BY name COLLATE NOCASE, id').all();
  if (serviceOrderRows.length && serviceOrderRows.every(r => Number(r.display_order || 0) === 0)) {
    const setOrder = db.prepare('UPDATE network_services SET display_order=? WHERE id=?');
    const tx = db.transaction(rows => rows.forEach((row, i) => setOrder.run(i, row.id)));
    tx(serviceOrderRows);
  }

  const serviceMetricColumns = db.prepare('PRAGMA table_info(service_metrics)').all().map(c => c.name);
  if (!serviceMetricColumns.includes('extra_json')) db.exec('ALTER TABLE service_metrics ADD COLUMN extra_json TEXT');

  // RouterDeck 0.9 keeps the Catppuccin flavors and adds a true AMOLED-black option.
  // Rebuild older app_settings tables so their CHECK constraint accepts every current theme.
  const appSettingsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='app_settings'").get()?.sql || '';
  if (appSettingsSql && (!appSettingsSql.includes("'latte'") || !appSettingsSql.includes("'amoled'"))) {
    db.exec(`
      BEGIN;
      CREATE TABLE app_settings_v09 (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        app_name TEXT NOT NULL DEFAULT 'RouterDeck',
        clock_format TEXT NOT NULL DEFAULT '24h' CHECK(clock_format IN ('12h','24h')),
        theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','latte','frappe','macchiato','mocha','amoled')),
        time_zone TEXT NOT NULL DEFAULT 'auto',
        updated_at INTEGER NOT NULL
      );
      INSERT INTO app_settings_v09 (id,app_name,clock_format,theme,time_zone,updated_at)
      SELECT id,app_name,clock_format,
        CASE theme WHEN 'light' THEN 'latte' WHEN 'dark' THEN 'mocha' ELSE theme END,
        'auto', updated_at
      FROM app_settings;
      DROP TABLE app_settings;
      ALTER TABLE app_settings_v09 RENAME TO app_settings;
      COMMIT;
    `);
  }

  // Upgrade pre-0.4 databases whose devices CHECK constraint only allowed OpenWrt/MikroTik.
  const devicesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get()?.sql || '';
  if (!devicesSql.includes("'generic'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE devices_v04 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        os_type TEXT NOT NULL CHECK(os_type IN ('openwrt','mikrotik','generic','ruijie')),
        connection_mode TEXT NOT NULL DEFAULT 'ssh',
        rest_scheme TEXT DEFAULT 'https',
        rest_port INTEGER,
        monitor_interface TEXT,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO devices_v04
        (id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,credentials_enc,created_at)
      SELECT id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,credentials_enc,created_at
      FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_v04 RENAME TO devices;
      CREATE INDEX idx_devices_host ON devices(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }


  // Ensure role/model columns exist before the v1.5 table rebuild, including on unusually old databases.
  const preV15DeviceColumns = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!preV15DeviceColumns.includes('device_role')) db.exec("ALTER TABLE devices ADD COLUMN device_role TEXT NOT NULL DEFAULT 'client'");
  if (!preV15DeviceColumns.includes('detected_model')) db.exec("ALTER TABLE devices ADD COLUMN detected_model TEXT DEFAULT ''");

  // RouterDeck 1.5 adds Ruijie/Reyee Cloud-managed switches as network devices.
  const devicesSqlV15 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get()?.sql || '';
  if (devicesSqlV15 && !devicesSqlV15.includes("'ruijie'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE devices_v15 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        os_type TEXT NOT NULL CHECK(os_type IN ('openwrt','mikrotik','generic','ruijie')),
        connection_mode TEXT NOT NULL DEFAULT 'ssh',
        rest_scheme TEXT DEFAULT 'https',
        rest_port INTEGER,
        monitor_interface TEXT,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        device_role TEXT NOT NULL DEFAULT 'client',
        detected_model TEXT DEFAULT '',
        credentials_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO devices_v15
        (id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,device_role,detected_model,credentials_enc,created_at)
      SELECT id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,
        COALESCE(device_role,'client'),COALESCE(detected_model,''),credentials_enc,created_at
      FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_v15 RENAME TO devices;
      CREATE INDEX idx_devices_host ON devices(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }


  // RouterDeck 0.2 removed the old OpenWrt HTTP agent and its legacy database fields.
  db.prepare("UPDATE devices SET connection_mode='ssh' WHERE os_type='openwrt'").run();
  const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (deviceColumns.includes('agent_scheme')) db.exec('ALTER TABLE devices DROP COLUMN agent_scheme');
  if (deviceColumns.includes('agent_port')) db.exec('ALTER TABLE devices DROP COLUMN agent_port');
  if (!deviceColumns.includes('device_role')) db.exec("ALTER TABLE devices ADD COLUMN device_role TEXT NOT NULL DEFAULT 'client'");
  if (!deviceColumns.includes('detected_model')) db.exec("ALTER TABLE devices ADD COLUMN detected_model TEXT DEFAULT ''");
  if (!deviceColumns.includes('display_order')) db.exec("ALTER TABLE devices ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");


  // RouterDeck 1.14 removes the experimental Reyee EW local-eWeb device type.
  // Existing EW entries are preserved as generic ICMP uptime monitors so an upgrade
  // never deletes a user's target or its uptime history.
  const devicesSqlV114 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get()?.sql || '';
  if (devicesSqlV114.includes("'ruijie_ew'")) {
    db.prepare("UPDATE devices SET os_type='generic', connection_mode='icmp', rest_scheme='https', rest_port=NULL, monitor_interface=NULL, insecure_tls=0, device_role='client', credentials_enc=? WHERE os_type='ruijie_ew'").run(encryptJson({}));
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE devices_v114 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        os_type TEXT NOT NULL CHECK(os_type IN ('openwrt','mikrotik','generic','ruijie')),
        connection_mode TEXT NOT NULL DEFAULT 'ssh',
        rest_scheme TEXT DEFAULT 'https',
        rest_port INTEGER,
        monitor_interface TEXT,
        insecure_tls INTEGER NOT NULL DEFAULT 0,
        device_role TEXT NOT NULL DEFAULT 'client',
        detected_model TEXT DEFAULT '',
        credentials_enc TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO devices_v114
        (id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,device_role,detected_model,credentials_enc,display_order,created_at)
      SELECT id,name,host,os_type,connection_mode,rest_scheme,rest_port,monitor_interface,insecure_tls,
        COALESCE(device_role,'client'),COALESCE(detected_model,''),credentials_enc,COALESCE(display_order,0),created_at
      FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_v114 RENAME TO devices;
      CREATE INDEX idx_devices_host ON devices(host);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  // RouterDeck 1.13 stores the Overview card order independently from names.
  // Seed older databases deterministically while keeping the single gateway first.
  const deviceOrderRows = db.prepare("SELECT id, os_type, device_role, display_order, name FROM devices ORDER BY CASE WHEN os_type='mikrotik' AND device_role='host' THEN 0 ELSE 1 END, name COLLATE NOCASE, id").all();
  if (deviceOrderRows.length && deviceOrderRows.every(r => Number(r.display_order || 0) === 0)) {
    const setOrder = db.prepare('UPDATE devices SET display_order=? WHERE id=?');
    const tx = db.transaction(rows => rows.forEach((row, i) => setOrder.run(i, row.id)));
    tx(deviceOrderRows);
  }

  // RouterDeck 1.0 allows at most one MikroTik Host / gateway.  If an older
  // database has multiple hosts, preserve the oldest and demote the rest.
  const gatewayRows = db.prepare("SELECT id FROM devices WHERE os_type='mikrotik' AND device_role='host' ORDER BY id ASC").all();
  if (gatewayRows.length > 1) {
    const keep = gatewayRows[0].id;
    db.prepare("UPDATE devices SET device_role='client' WHERE os_type='mikrotik' AND device_role='host' AND id<>?").run(keep);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_mikrotik_host ON devices(device_role) WHERE os_type='mikrotik' AND device_role='host'");

  // RouterDeck topology uses the existing inventory. Since 1.17.4 only network
  // devices are rendered; legacy service nodes are removed by the topology sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS topology_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES network_services(id) ON DELETE CASCADE,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      CHECK (
        (device_id IS NOT NULL AND service_id IS NULL) OR
        (device_id IS NULL AND service_id IS NOT NULL)
      ),
      UNIQUE(device_id),
      UNIQUE(service_id)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_device ON topology_nodes(device_id);
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_service ON topology_nodes(service_id);

    CREATE TABLE IF NOT EXISTS topology_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_node_id INTEGER NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
      target_node_id INTEGER NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      CHECK(source_node_id <> target_node_id),
      UNIQUE(source_node_id, target_node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_links_source ON topology_links(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_topology_links_target ON topology_links(target_node_id);
  `);

  db.prepare(`INSERT OR IGNORE INTO status_page_settings
    (id,title,subtitle,show_hosts,refresh_seconds,accent,updated_at)
    VALUES (1,'Network Status','Live uptime status for monitored services and devices.',0,30,'#6f8cff',?)`).run(Date.now());

  const appSettingColumns = db.prepare('PRAGMA table_info(app_settings)').all().map(c => c.name);
  if (!appSettingColumns.includes('time_zone')) db.exec("ALTER TABLE app_settings ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'auto'");

  db.prepare(`INSERT OR IGNORE INTO app_settings
    (id,app_name,clock_format,theme,time_zone,updated_at)
    VALUES (1,'RouterDeck','24h','system','auto',?)`).run(Date.now());
}
