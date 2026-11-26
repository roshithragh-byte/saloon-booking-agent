/**
 * Salon Services Catalog & Customer Profile Store
 * Supports both PostgreSQL Database and in-memory fallback
 */
"use strict";

const salonConfig = require('../data/salon-config.json');
const calendarService = require('./calendar');
const db = require('./db');
const { syncToSalonBackend } = require('./sync-service');

// In-memory fallback stores
const memoryCustomers = new Map();
const memoryAppointments = [];

module.exports = {
  getDb() {
    return db;
  },

  getSalonDetails() {
    return {
      salonName: salonConfig.salonName,
      tagline: salonConfig.tagline,
      address: salonConfig.address,
      openingTime: salonConfig.openingTime,
      closingTime: salonConfig.closingTime,
      happyHours: salonConfig.happyHours,
      privilegeWallet: salonConfig.privilegeWallet,
      categories: salonConfig.categories
    };
  },

  getCategories() {
    return salonConfig.categories;
  },

  getCombosList(targetGender = null) {
    if (!targetGender) return salonConfig.combos;
    return salonConfig.combos.filter(c => c.targetGender === targetGender || c.targetGender === "unisex");
  },

  getAllServices(targetGender = null) {
    if (!targetGender) return salonConfig.services;
    return salonConfig.services.filter(s => s.targetGender === targetGender || s.targetGender === "unisex");
  },

  getCatalogSectionsForGender(gender = "men") {
    const isMen = gender.toLowerCase() === "men";
    const relevantCombos = this.getCombosList(isMen ? "men" : "women");
    const relevantServices = this.getAllServices(isMen ? "men" : "women");

    const sections = [];
    let remainingBudget = 10; // WhatsApp Cloud API limit: total across all sections <= 10

    // Section 1: Signature Combos (up to 3 combos)
    if (relevantCombos.length > 0) {
      const comboRows = relevantCombos.slice(0, 3).map(c => ({
        id: c.id,
        title: c.name.substring(0, 24),
        description: `${c.priceFormatted} · ${c.durationMin}m · ${c.savings}`
      }));
      sections.push({
        title: (isMen ? "Value Combos" : "Signature Combos").substring(0, 24),
        rows: comboRows
      });
      remainingBudget -= comboRows.length;
    }

    // Section 2: Popular Hair Cuts & Styling (up to 4 items)
    const hair = relevantServices.filter(s => s.category.includes("Hair"));
    if (hair.length > 0 && remainingBudget > 0) {
      const hairCount = Math.min(hair.length, 4, remainingBudget);
      const hairRows = hair.slice(0, hairCount).map(s => ({
        id: s.id,
        title: s.name.substring(0, 24),
        description: `${s.priceFormatted} · ${s.durationMin} mins`
      }));
      sections.push({
        title: (isMen ? "Cuts & Grooming" : "Hair & Styling").substring(0, 24),
        rows: hairRows
      });
      remainingBudget -= hairRows.length;
    }

    // Section 3: Facials, Spas & Care (fill remaining slots up to 10 total)
    const skinAndSpa = relevantServices.filter(s => s.category.includes("Skin") || s.category.includes("Spa") || s.category.includes("Hands") || s.category.includes("Color"));
    if (skinAndSpa.length > 0 && remainingBudget > 0) {
      const spaRows = skinAndSpa.slice(0, remainingBudget).map(s => ({
        id: s.id,
        title: s.name.substring(0, 24),
        description: `${s.priceFormatted} · ${s.durationMin} mins`
      }));
      sections.push({
        title: "Facials & Spa Care".substring(0, 24),
        rows: spaRows
      });
    }

    return sections;
  },

  getStaffList() {
    return salonConfig.staff;
  },

  findItemById(id) {
    if (!id) return null;
    const cleanId = id.trim().toLowerCase();
    const service = salonConfig.services.find(s => s.id.toLowerCase() === cleanId);
    if (service) return { ...service, itemType: "service" };

    const combo = salonConfig.combos.find(c => c.id.toLowerCase() === cleanId);
    if (combo) return { ...combo, itemType: "combo" };

    return null;
  },

  findItemByName(name) {
    if (!name) return null;
    const cleanName = name.trim().toLowerCase();

    const service = salonConfig.services.find(s => 
      s.name.toLowerCase() === cleanName ||
      cleanName.includes(s.name.toLowerCase()) ||
      s.name.toLowerCase().includes(cleanName)
    );
    if (service) return { ...service, itemType: "service" };

    const combo = salonConfig.combos.find(c =>
      c.name.toLowerCase() === cleanName ||
      cleanName.includes(c.name.toLowerCase()) ||
      c.name.toLowerCase().includes(cleanName)
    );
    if (combo) return { ...combo, itemType: "combo" };

    return null;
  },

  getServicesByCategory(categoryId) {
    if (categoryId === "cat_combos") {
      return salonConfig.combos;
    }
    return salonConfig.services.filter(s => s.categoryId === categoryId);
  },

  // Customer Profile Management (PostgreSQL + In-Memory Fallback)
  async getOrCreateCustomer(phone, defaultName = null) {
    if (!phone) return null;

    if (db.getPool()) {
      try {
        const res = await db.query('SELECT * FROM customers WHERE phone = $1', [phone]);
        if (res.rows.length > 0) {
          return {
            phone: res.rows[0].phone,
            name: res.rows[0].name,
            totalVisits: res.rows[0].total_visits
          };
        }
        // Insert new customer
        const initialName = defaultName || "Valued Guest";
        const insertRes = await db.query(
          'INSERT INTO customers (phone, name, total_visits) VALUES ($1, $2, 0) RETURNING *',
          [phone, initialName]
        );
        return {
          phone: insertRes.rows[0].phone,
          name: insertRes.rows[0].name,
          totalVisits: insertRes.rows[0].total_visits
        };
      } catch (err) {
        console.error("DB getOrCreateCustomer error, using memory fallback:", err.message);
      }
    }

    // Fallback to memory
    if (!memoryCustomers.has(phone)) {
      memoryCustomers.set(phone, {
        phone,
        name: defaultName || "Valued Guest",
        totalVisits: 0
      });
    } else if (defaultName && memoryCustomers.get(phone).name === "Valued Guest") {
      memoryCustomers.get(phone).name = defaultName;
    }
    return memoryCustomers.get(phone);
  },

  async updateCustomerName(phone, name) {
    if (!phone || !name) return;

    if (db.getPool()) {
      try {
        await db.query(
          `INSERT INTO customers (phone, name, total_visits) 
           VALUES ($1, $2, 0) 
           ON CONFLICT (phone) DO UPDATE SET name = $2, updated_at = CURRENT_TIMESTAMP`,
          [phone, name]
        );
      } catch (err) {
        console.error("DB updateCustomerName error:", err.message);
      }
    }

    const mem = await this.getOrCreateCustomer(phone);
    if (mem) mem.name = name;
  },

  async getCustomerUpcomingAppointments(phone) {
    if (!phone) return [];
    const today = new Date().toISOString().split('T')[0];

    if (db.getPool()) {
      try {
        const res = await db.query(
          `SELECT id, customer_name AS "customerName", customer_phone AS "customerPhone",
                  service_name AS "serviceName", date, time, staff_name AS "staffName",
                  price, status
           FROM appointments 
           WHERE customer_phone = $1 AND date >= $2 AND status != 'cancelled'
           ORDER BY date ASC, time ASC`,
          [phone, today]
        );
        return res.rows;
      } catch (err) {
        console.error("DB getCustomerUpcomingAppointments error:", err.message);
      }
    }

    return memoryAppointments.filter(app => 
      app.customerPhone === phone && 
      app.date >= today &&
      app.status !== "cancelled"
    );
  },

  async getAllAppointments() {
    if (db.getPool()) {
      try {
        const res = await db.query(
          `SELECT id, customer_name AS "customerName", customer_phone AS "customerPhone",
                  service_name AS "serviceName", date, time, staff_name AS "staffName",
                  price, status, created_at AS "createdAt"
           FROM appointments 
           ORDER BY date DESC, time DESC`
        );
        return res.rows;
      } catch (err) {
        console.error("DB getAllAppointments error:", err.message);
      }
    }
    return memoryAppointments;
  },

  async getAvailableSlotsForService(serviceIdOrName, date) {
    const item = this.findItemById(serviceIdOrName) || this.findItemByName(serviceIdOrName);
    const durationMin = item ? item.durationMin : 45;
    const res = await calendarService.getAvailableSlots(date, durationMin);
    if (res && Array.isArray(res.slots)) {
      return res.slots;
    }
    if (Array.isArray(res)) {
      return res;
    }
    return [];
  },

  async createBooking(booking) {
    // Generate collision-resistant sequential booking ID: NU-YYYYMMDD-XXXX
    const dateCompact = (booking.date || new Date().toISOString().split('T')[0]).replace(/-/g, '');
    const randomHex = Math.random().toString(36).substring(2, 6).toUpperCase();
    const id = `NU-${dateCompact}-${randomHex}`;

    const item = this.findItemById(booking.serviceId) || this.findItemByName(booking.service);
    const serviceName = item ? item.name : (booking.serviceName || booking.service || "Salon Treatment");
    const durationMin = item ? item.durationMin : (booking.durationMin || 45);
    const priceFormatted = item ? item.priceFormatted : (booking.price || "₹350");
    const staffName = booking.staffName || (item && item.eligibleStaff ? item.eligibleStaff[0] : "Senior Stylist");

    // Update customer profile
    if (booking.customerPhone && booking.customerName) {
      await this.updateCustomerName(booking.customerPhone, booking.customerName);
    }

    const record = {
      id,
      customerPhone: booking.customerPhone,
      customerName: booking.customerName || "Valued Guest",
      serviceId: item ? item.id : null,
      serviceName,
      durationMin,
      price: priceFormatted,
      staffName,
      date: booking.date,
      time: booking.time,
      status: "confirmed",
      location: salonConfig.address,
      createdAt: new Date().toISOString()
    };

    // Store in memory
    memoryAppointments.push(record);

    // Persist in PostgreSQL using an atomic transaction
    if (db.getPool()) {
      let client = null;
      try {
        client = await db.getClient();
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO appointments (id, customer_phone, customer_name, service_id, service_name, duration_min, price, staff_name, date, time, status, location)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            record.id,
            record.customerPhone,
            record.customerName,
            record.serviceId,
            record.serviceName,
            record.durationMin,
            record.price,
            record.staffName,
            record.date,
            record.time,
            record.status,
            record.location
          ]
        );

        await client.query(
          `UPDATE customers SET total_visits = total_visits + 1 WHERE phone = $1`,
          [record.customerPhone]
        );

        // Queue integration synchronization jobs into integration_outbox
        const outboxIdCal = `outbox_cal_${record.id}`;
        await client.query(
          `INSERT INTO integration_outbox (id, booking_id, target, payload, status)
           VALUES ($1, $2, 'GOOGLE_CALENDAR', $3, 'PENDING')
           ON CONFLICT (id) DO NOTHING`,
          [outboxIdCal, record.id, JSON.stringify(record)]
        );

        const outboxIdCrm = `outbox_crm_${record.id}`;
        await client.query(
          `INSERT INTO integration_outbox (id, booking_id, target, payload, status)
           VALUES ($1, $2, 'RAILWAY_CRM', $3, 'PENDING')
           ON CONFLICT (id) DO NOTHING`,
          [outboxIdCrm, record.id, JSON.stringify(record)]
        );

        await client.query('COMMIT');
      } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Failed to insert appointment transaction into PostgreSQL:", err.message);
      } finally {
        if (client) client.release();
      }
    }

    // Sync to Google Calendar
    try {
      if (calendarService.isAuthorized()) {
        const calEvent = await calendarService.createCalendarEvent(record);
        record.calendarEventLink = calEvent.htmlLink;
      }
    } catch (err) {
      console.error("Failed to sync booking to Google Calendar:", err.message);
    }

    // Sync to Railway Salon CRM Backend (PostgreSQL)
    try {
      const backendBooking = await syncToSalonBackend(record);
      if (backendBooking) {
        record.crmBookingId = backendBooking.id;
      }
    } catch (err) {
      console.error("Failed to sync booking to Railway CRM:", err.message);
    }

    return record;
  }
};
