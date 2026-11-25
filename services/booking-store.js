/**
 * Salon Services Catalog & Customer Profile Store with Google Calendar integration
 */
"use strict";

const salonConfig = require('../data/salon-config.json');
const calendarService = require('./calendar');

// In-memory customer profiles: phone -> { name, phone, visits, notes, createdAt }
const customerProfiles = new Map();

// In-memory appointments list: array of booking records
const appointments = [];

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

  // Lookup service or combo by exact ID or fuzzy search
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
    
    // Direct or includes match
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

  getAllServices() {
    return salonConfig.services;
  },

  // Customer Profile Management
  getOrCreateCustomer(phone, defaultName = null) {
    if (!phone) return null;
    if (!customerProfiles.has(phone)) {
      customerProfiles.set(phone, {
        phone,
        name: defaultName || "Valued Guest",
        totalVisits: 0,
        createdAt: new Date().toISOString()
      });
    } else if (defaultName && customerProfiles.get(phone).name === "Valued Guest") {
      customerProfiles.get(phone).name = defaultName;
    }
    return customerProfiles.get(phone);
  },

  updateCustomerName(phone, name) {
    if (!phone || !name) return;
    const profile = this.getOrCreateCustomer(phone);
    profile.name = name;
  },

  getCustomerUpcomingAppointments(phone) {
    if (!phone) return [];
    const today = new Date().toISOString().split('T')[0];
    return appointments.filter(app => 
      app.customerPhone === phone && 
      app.date >= today &&
      app.status !== "cancelled"
    );
  },

  async getAvailableSlotsForService(serviceIdOrName, date) {
    const item = this.findItemById(serviceIdOrName) || this.findItemByName(serviceIdOrName);
    const durationMin = item ? item.durationMin : 45;
    return calendarService.getAvailableSlots(date, durationMin);
  },

  getAllAppointments() {
    return appointments;
  },

  getTodayAppointments() {
    const today = new Date().toISOString().split('T')[0];
    return appointments.filter(app => app.date === today && app.status !== "cancelled");
  },

  async createBooking(booking) {
    const id = "NU-" + Math.floor(1000 + Math.random() * 9000);

    const item = this.findItemById(booking.serviceId) || this.findItemByName(booking.service);
    const serviceName = item ? item.name : (booking.serviceName || booking.service || "Salon Treatment");
    const durationMin = item ? item.durationMin : (booking.durationMin || 45);
    const priceFormatted = item ? item.priceFormatted : (booking.price || "₹350");
    const staffName = booking.staffName || (item && item.eligibleStaff ? item.eligibleStaff[0] : "Senior Stylist");

    // Persist or update customer name
    if (booking.customerPhone && booking.customerName) {
      this.updateCustomerName(booking.customerPhone, booking.customerName);
    }

    const customer = this.getOrCreateCustomer(booking.customerPhone, booking.customerName);
    if (customer) {
      customer.totalVisits = (customer.totalVisits || 0) + 1;
    }

    const record = {
      id,
      customerPhone: booking.customerPhone,
      customerName: booking.customerName || customer.name,
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

    appointments.push(record);

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
