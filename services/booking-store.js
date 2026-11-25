/**
 * Salon Services Catalog & Customer Profile Store
 * Supports both PostgreSQL Database and in-memory fallback
 */
"use strict";

const salonConfig = require('../data/salon-config.json');
const calendarService = require('./calendar');
const db = require('./db');

// In-memory fallback stores
const memoryCustomers = new Map();
const memoryAppointments = [];

module.exports = {
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

  getCombosList() {
    return salonConfig.combos;
  },

  getAllServices() {
    return salonConfig.services;
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
    return calendarService.getAvailableSlots(date, durationMin);
  },

  async createBooking(booking) {
    const id = "NU-" + Math.floor(1000 + Math.random() * 9000);

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

    // Persist in PostgreSQL
    if (db.getPool()) {
      try {
        await db.query(
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

        await db.query(
          `UPDATE customers SET total_visits = total_visits + 1 WHERE phone = $1`,
          [record.customerPhone]
        );
      } catch (err) {
        console.error("Failed to insert appointment into PostgreSQL:", err.message);
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

    return record;
  }
};
