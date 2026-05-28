const CONFIG = {
  timezone: "Asia/Kolkata",
  cutoffHour: 21,
  sessionSeconds: 21600,
  sheets: {
    customers: "Customers",
    owners: "Owners",
    brands: "Brands",
    orders: "Orders",
    reportsLog: "ReportsLog",
  },
};

function doGet() {
  return jsonResponse_({
    success: true,
    message: "MilkMate Apps Script backend is running.",
  });
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const action = payload.action;

    if (action === "login") {
      return jsonResponse_(login_(payload));
    }

    if (action === "getConfig") {
      return jsonResponse_(getConfig_(payload));
    }

    if (action === "getProfile") {
      return jsonResponse_(getProfile_(payload));
    }

    if (action === "getCustomerOrders") {
      return jsonResponse_(getCustomerOrders_(payload));
    }

    if (action === "upsertOrder") {
      return jsonResponse_(upsertOrder_(payload));
    }

    if (action === "deleteOrder") {
      return jsonResponse_(deleteOrder_(payload));
    }

    if (action === "getOwnerDashboard") {
      return jsonResponse_(getOwnerDashboard_(payload));
    }

    if (action === "listCustomers") {
      return jsonResponse_(listCustomers_(payload));
    }

    if (action === "saveCustomer") {
      return jsonResponse_(saveCustomer_(payload));
    }

    if (action === "deleteCustomer") {
      return jsonResponse_(deleteCustomer_(payload));
    }

    if (action === "generateCustomerBill") {
      return jsonResponse_(generateCustomerBill_(payload));
    }

    return jsonResponse_({
      success: false,
      message: "Unknown action.",
    });
  } catch (error) {
    return jsonResponse_({
      success: false,
      message: error.message,
    });
  }
}

function login_(payload) {
  const role = String(payload.role || "").trim();
  const userId = String(payload.userId || "").trim();
  const password = String(payload.password || "");

  if (!role || !userId || !password) {
    return {
      success: false,
      message: "Role, user ID, and password are required.",
    };
  }

  const sheetName = role === "owner" ? CONFIG.sheets.owners : CONFIG.sheets.customers;
  const idColumn = role === "owner" ? "ownerId" : "customerId";
  const account = findRowByValue_(sheetName, idColumn, userId);

  if (!account || !isActive_(account.data.active)) {
    return {
      success: false,
      message: "Invalid or inactive account.",
    };
  }

  if (!account.data.passwordSalt || !account.data.passwordHash) {
    return {
      success: false,
      message: "Password hash is not prepared. Run hashInitialPasswords first.",
    };
  }

  if (!verifyPassword_(password, account.data.passwordSalt, account.data.passwordHash)) {
    return {
      success: false,
      message: "Invalid user ID or password.",
    };
  }

  const session = createSession_(role, account.data);

  return {
    success: true,
    token: session.token,
    role: session.role,
    userId: session.userId,
    name: session.name,
    email: session.email || "",
  };
}

function getConfig_(payload) {
  requireSession_(payload.token);

  const brands = readRows_(CONFIG.sheets.brands)
    .rows
    .filter((row) => isActive_(row.data.active))
    .map((row) => ({
      brandId: row.data.brandId,
      brandName: row.data.brandName,
      ratePerLitre: Number(row.data.ratePerLitre),
    }));

  return {
    success: true,
    brands,
  };
}

function getProfile_(payload) {
  const session = requireSession_(payload.token);
  const account = getAccountBySession_(session);

  if (!account || !isActive_(account.data.active)) {
    return {
      success: false,
      message: "Account is not active.",
    };
  }

  return {
    success: true,
    role: session.role,
    userId: session.userId,
    name: account.data.name,
    email: account.data.email || "",
  };
}

function getCustomerOrders_(payload) {
  const session = requireSession_(payload.token, "customer");
  const account = getAccountBySession_(session);
  const requestedMonth = String(payload.month || "").trim();
  const requestedDate = String(payload.orderDate || "").trim();

  const orders = readRows_(CONFIG.sheets.orders)
    .rows
    .filter((row) => row.data.customerId === session.userId)
    .filter((row) => row.data.status !== "DELETED")
    .filter((row) => {
      const orderDate = dateKey_(row.data.orderDate);
      if (requestedDate) {
        return orderDate === requestedDate;
      }
      if (requestedMonth) {
        return orderDate.indexOf(requestedMonth + "-") === 0;
      }
      return true;
    })
    .map((row) => {
      return orderResponse_({
        ...row.data,
        customerName: account ? account.data.name : row.data.customerName,
      });
    });

  return {
    success: true,
    orders,
  };
}

function upsertOrder_(payload) {
  const session = requireSession_(payload.token, "customer");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const orderDate = String(payload.orderDate || "").trim();
    const brandId = String(payload.brandId || "").trim();
    const quantityLitres = Number(payload.quantityLitres);
    const brand = getActiveBrand_(brandId);

    validateOrderInput_(orderDate, brand, quantityLitres);
    validateCutoff_(orderDate);

    const amount = quantityLitres * Number(brand.ratePerLitre);
    const ordersData = readRows_(CONFIG.sheets.orders);
    const existing = ordersData.rows.find((row) => {
      return (
        row.data.customerId === session.userId &&
        dateKey_(row.data.orderDate) === orderDate &&
        row.data.status !== "DELETED"
      );
    });

    const now = nowText_();
    const order = {
      orderId: existing ? existing.data.orderId : `${session.userId}-${orderDate}`,
      customerId: session.userId,
      customerName: session.name,
      orderDate,
      brandId: brand.brandId,
      brandName: brand.brandName,
      quantityLitres,
      ratePerLitre: Number(brand.ratePerLitre),
      amount,
      status: "ACTIVE",
      createdAt: existing ? existing.data.createdAt : now,
      updatedAt: now,
    };

    if (existing) {
      updateRow_(ordersData.sheet, existing.rowNumber, ordersData.headers, order);
    } else {
      appendRow_(ordersData.sheet, ordersData.headers, order);
    }

    return {
      success: true,
      message: "Order saved.",
      order: orderResponse_(order),
    };
  } finally {
    lock.releaseLock();
  }
}

function deleteOrder_(payload) {
  const session = requireSession_(payload.token, "customer");
  const orderDate = String(payload.orderDate || "").trim();
  validateCutoff_(orderDate);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ordersData = readRows_(CONFIG.sheets.orders);
    const existing = ordersData.rows.find((row) => {
      return (
        row.data.customerId === session.userId &&
        dateKey_(row.data.orderDate) === orderDate &&
        row.data.status !== "DELETED"
      );
    });

    if (!existing) {
      return {
        success: false,
        message: "No active order found for this date.",
      };
    }

    updateRow_(ordersData.sheet, existing.rowNumber, ordersData.headers, {
      status: "DELETED",
      updatedAt: nowText_(),
    });

    return {
      success: true,
      message: "Order deleted.",
    };
  } finally {
    lock.releaseLock();
  }
}

function getOwnerDashboard_(payload) {
  requireSession_(payload.token, "owner");
  const orderDate = String(payload.orderDate || getTomorrowDateKey_()).trim();
  const activeOrders = getActiveOrdersForDate_(orderDate);
  const brandTotals = {};

  activeOrders.forEach((order) => {
    if (!brandTotals[order.brandId]) {
      brandTotals[order.brandId] = {
        brandId: order.brandId,
        brandName: order.brandName,
        quantityLitres: 0,
        ratePerLitre: Number(order.ratePerLitre),
        amount: 0,
      };
    }

    brandTotals[order.brandId].quantityLitres += Number(order.quantityLitres);
    brandTotals[order.brandId].amount += Number(order.amount);
  });

  return {
    success: true,
    orderDate,
    orders: activeOrders.map(orderResponse_),
    brandTotals: Object.keys(brandTotals).map((brandId) => brandTotals[brandId]),
    totalLitres: activeOrders.reduce((sum, order) => sum + Number(order.quantityLitres), 0),
    orderCount: activeOrders.length,
  };
}

function listCustomers_(payload) {
  requireSession_(payload.token, "owner");

  const customers = readRows_(CONFIG.sheets.customers)
    .rows
    .map((row) => ({
      customerId: row.data.customerId,
      name: row.data.name,
      phone: row.data.phone,
      active: isActive_(row.data.active),
      createdAt: row.data.createdAt,
    }));

  return {
    success: true,
    customers,
  };
}

function saveCustomer_(payload) {
  requireSession_(payload.token, "owner");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const customerId = String(payload.customerId || "").trim();
    const name = String(payload.name || "").trim();
    const phone = String(payload.phone || "").trim();
    const password = String(payload.password || "");
    const active = payload.active === false ? "FALSE" : "TRUE";

    if (!customerId || !name) {
      return {
        success: false,
        message: "Customer ID and name are required.",
      };
    }

    const table = readRows_(CONFIG.sheets.customers);
    const existing = table.rows.find((row) => String(row.data.customerId) === customerId);
    const now = nowText_();
    const changes = {
      customerId,
      name,
      phone,
      active,
      createdAt: existing ? existing.data.createdAt : now,
    };

    if (password) {
      const salt = Utilities.getUuid();
      changes.initialPassword = "";
      changes.passwordSalt = salt;
      changes.passwordHash = hashPassword_(password, salt);
    } else if (!existing) {
      return {
        success: false,
        message: "Password is required for a new customer.",
      };
    }

    if (existing) {
      updateRow_(table.sheet, existing.rowNumber, table.headers, changes);
    } else {
      appendRow_(table.sheet, table.headers, changes);
    }

    syncOrderCustomerNames();

    return {
      success: true,
      message: existing ? "Customer updated." : "Customer added.",
    };
  } finally {
    lock.releaseLock();
  }
}

function deleteCustomer_(payload) {
  requireSession_(payload.token, "owner");
  const customerId = String(payload.customerId || "").trim();

  if (!customerId) {
    return {
      success: false,
      message: "Customer ID is required.",
    };
  }

  const table = readRows_(CONFIG.sheets.customers);
  const existing = table.rows.find((row) => String(row.data.customerId) === customerId);

  if (!existing) {
    return {
      success: false,
      message: "Customer not found.",
    };
  }

  updateRow_(table.sheet, existing.rowNumber, table.headers, {
    active: "FALSE",
  });

  return {
    success: true,
    message: "Customer deactivated.",
  };
}

function generateCustomerBill_(payload) {
  requireSession_(payload.token, "owner");
  const customerId = String(payload.customerId || "").trim();
  const startDate = String(payload.startDate || "").trim();
  const endDate = String(payload.endDate || "").trim();

  if (!customerId || !isDateKey_(startDate) || !isDateKey_(endDate)) {
    return {
      success: false,
      message: "Customer, start date, and end date are required.",
    };
  }

  if (startDate > endDate) {
    return {
      success: false,
      message: "Start date must be before end date.",
    };
  }

  const customer = findRowByValue_(CONFIG.sheets.customers, "customerId", customerId);

  if (!customer || !isActive_(customer.data.active)) {
    return {
      success: false,
      message: "Active customer not found.",
    };
  }

  const orders = readRows_(CONFIG.sheets.orders)
    .rows
    .map((row) => row.data)
    .filter((order) => order.customerId === customerId)
    .filter((order) => order.status !== "DELETED")
    .filter((order) => {
      const orderDate = dateKey_(order.orderDate);
      return orderDate >= startDate && orderDate <= endDate;
    })
    .map((order) => ({
      ...order,
      customerName: customer.data.name,
    }));

  const totalLitres = orders.reduce((sum, order) => sum + Number(order.quantityLitres), 0);
  const totalAmount = orders.reduce((sum, order) => sum + Number(order.amount), 0);
  const ownerEmails = getOwnerEmails_();
  const subject = `Milk bill for ${customer.data.name} (${startDate} to ${endDate})`;
  const body = [
    `Milk bill for ${customer.data.name}`,
    `Customer ID: ${customerId}`,
    `Period: ${startDate} to ${endDate}`,
    "",
    `Total litres: ${totalLitres}`,
    `Total amount: Rs. ${totalAmount}`,
  ].join("\n");
  const attachments = [
    createCsvAttachment_(
      `bill-${customerId}-${startDate}-to-${endDate}.csv`,
      buildCustomerBillRows_(orders, customer.data, startDate, endDate)
    ),
  ];

  ownerEmails.forEach((email) => {
    MailApp.sendEmail({
      to: email,
      subject,
      body,
      attachments,
    });
  });

  return {
    success: true,
    message: `Bill emailed to owner for ${customer.data.name}.`,
  };
}

function sendDailyOwnerReport() {
  const orderDate = getTomorrowDateKey_();
  const reportType = "DAILY";

  if (reportAlreadySent_(reportType, orderDate)) {
    return;
  }

  const dashboard = getOwnerDashboardForSystem_(orderDate);
  const ownerEmails = getOwnerEmails_();
  const subject = `Milk order report for ${orderDate}`;
  const body = buildDailyReportBody_(dashboard);
  const attachments = [
    createCsvAttachment_(
      `daily-orders-and-brand-totals-${orderDate}.csv`,
      buildDailyOrdersAndBrandTotalsRows_(dashboard.orders)
    ),
  ];

  ownerEmails.forEach((email) => {
    MailApp.sendEmail({
      to: email,
      subject,
      body,
      attachments,
    });
  });
  logReport_(reportType, orderDate, "SENT", `Sent to ${ownerEmails.join(", ")}`);
}

function sendMonthlyBills() {
  const today = new Date();
  today.setMonth(today.getMonth() - 1);
  const monthKey = Utilities.formatDate(today, CONFIG.timezone, "yyyy-MM");
  sendMonthlyBillsForMonth_(monthKey, false);
}

function sendMay2026MonthlyBills() {
  sendMonthlyBillsForMonth_("2026-05", true);
}

function sendCurrentMonthBills() {
  const monthKey = Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM");
  sendMonthlyBillsForMonth_(monthKey, true);
}

function sendMonthlyBillsForMonth_(monthKey, forceSend) {
  const reportType = "MONTHLY";

  if (!forceSend && reportAlreadySent_(reportType, monthKey)) {
    return;
  }

  const customerNames = getCustomerNameMap_();
  const orders = readRows_(CONFIG.sheets.orders)
    .rows
    .map((row) => row.data)
    .filter((order) => order.status !== "DELETED")
    .filter((order) => dateKey_(order.orderDate).indexOf(monthKey + "-") === 0)
    .map((order) => {
      return {
        ...order,
        customerName: customerNames[order.customerId] || order.customerName,
      };
    });

  const ownerEmails = getOwnerEmails_();
  const subject = `Monthly milk bills for ${monthKey}`;
  const body = buildMonthlyReportBody_(orders, monthKey);
  const attachments = [
    createCsvAttachment_(
      `monthly-bills-${monthKey}.csv`,
      buildMonthlyBillRows_(orders)
    ),
    createCsvAttachment_(
      `monthly-order-details-${monthKey}.csv`,
      [
        ["Date", "Customer", "Brand", "Quantity Litres", "Rate Per Litre", "Amount"],
        ...orders.map((order) => [
          dateKey_(order.orderDate),
          order.customerName,
          order.brandName,
          order.quantityLitres,
          order.ratePerLitre,
          order.amount,
        ]),
      ]
    ),
  ];

  ownerEmails.forEach((email) => {
    MailApp.sendEmail({
      to: email,
      subject,
      body,
      attachments,
    });
  });
  logReport_(reportType, monthKey, "SENT", `Sent to ${ownerEmails.join(", ")}${forceSend ? " manually" : ""}`);
}

function hashInitialPasswords() {
  const results = [
    hashInitialPasswordsForSheet_(CONFIG.sheets.customers, "customerId"),
    hashInitialPasswordsForSheet_(CONFIG.sheets.owners, "ownerId"),
  ];

  const message = results.join("\n");
  Logger.log(message);
  return message;
}

function syncOrderCustomerNames() {
  const customerNames = getCustomerNameMap_();
  const table = readRows_(CONFIG.sheets.orders);
  let updatedCount = 0;

  table.rows.forEach((row) => {
    const customerId = row.data.customerId;
    const latestName = customerNames[customerId];

    if (!latestName || row.data.customerName === latestName) {
      return;
    }

    updateRow_(table.sheet, row.rowNumber, table.headers, {
      customerName: latestName,
      updatedAt: nowText_(),
    });
    updatedCount += 1;
  });

  const message = `Orders: updated customer names in ${updatedCount} row(s).`;
  Logger.log(message);
  return message;
}

function hashInitialPasswordsForSheet_(sheetName, idColumnName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Missing sheet tab: ${sheetName}`);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return `${sheetName}: no account rows found.`;
  }

  const headers = values[0].map((header) => String(header).trim());
  const idIndex = getHeaderIndex_(headers, idColumnName);
  const initialPasswordIndex = getHeaderIndex_(headers, "initialPassword");
  const passwordSaltIndex = getHeaderIndex_(headers, "passwordSalt");
  const passwordHashIndex = getHeaderIndex_(headers, "passwordHash");

  let hashedCount = 0;
  let skippedAlreadyHashed = 0;
  let skippedMissingPassword = 0;

  values.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const accountId = String(row[idIndex] || "").trim();
    const initialPassword = String(row[initialPasswordIndex] || "").trim();
    const existingSalt = String(row[passwordSaltIndex] || "").trim();
    const existingHash = String(row[passwordHashIndex] || "").trim();

    if (!accountId) {
      return;
    }

    if (existingSalt && existingHash) {
      skippedAlreadyHashed += 1;
      return;
    }

    if (!initialPassword) {
      skippedMissingPassword += 1;
      return;
    }

    const salt = Utilities.getUuid();
    const passwordHash = hashPassword_(initialPassword, salt);

    sheet.getRange(rowNumber, initialPasswordIndex + 1).setValue("");
    sheet.getRange(rowNumber, passwordSaltIndex + 1).setValue(salt);
    sheet.getRange(rowNumber, passwordHashIndex + 1).setValue(passwordHash);
    hashedCount += 1;
  });

  return `${sheetName}: hashed ${hashedCount}, already hashed ${skippedAlreadyHashed}, missing initial password ${skippedMissingPassword}.`;
}

function installReportTriggers() {
  ScriptApp.newTrigger("sendDailyOwnerReport")
    .timeBased()
    .everyDays(1)
    .atHour(22)
    .nearMinute(0)
    .inTimezone(CONFIG.timezone)
    .create();

  ScriptApp.newTrigger("sendMonthlyBills")
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .nearMinute(0)
    .inTimezone(CONFIG.timezone)
    .create();
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  return JSON.parse(e.postData.contents);
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");

  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Set SPREADSHEET_ID in Script Properties.");
  }

  return spreadsheet;
}

function readRows_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Missing sheet tab: ${sheetName}`);
  }

  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const rows = values.slice(1).map((row, index) => {
    const data = {};
    headers.forEach((header, columnIndex) => {
      data[header] = row[columnIndex];
    });
    return {
      rowNumber: index + 2,
      data,
    };
  });

  return {
    sheet,
    headers,
    rows,
  };
}

function appendRow_(sheet, headers, data) {
  sheet.appendRow(headers.map((header) => data[header] !== undefined ? data[header] : ""));
}

function updateRow_(sheet, rowNumber, headers, changes) {
  headers.forEach((header, columnIndex) => {
    if (changes[header] !== undefined) {
      sheet.getRange(rowNumber, columnIndex + 1).setValue(changes[header]);
    }
  });
}

function getHeaderIndex_(headers, headerName) {
  const target = String(headerName).trim();
  const index = headers.findIndex((header) => String(header).trim() === target);

  if (index === -1) {
    throw new Error(`Missing required column: ${headerName}`);
  }

  return index;
}

function findRowByValue_(sheetName, columnName, value) {
  return readRows_(sheetName).rows.find((row) => String(row.data[columnName]) === String(value));
}

function getAccountBySession_(session) {
  const sheetName = session.role === "owner" ? CONFIG.sheets.owners : CONFIG.sheets.customers;
  const idColumn = session.role === "owner" ? "ownerId" : "customerId";
  return findRowByValue_(sheetName, idColumn, session.userId);
}

function getCustomerNameMap_() {
  return readRows_(CONFIG.sheets.customers)
    .rows
    .reduce((customerNames, row) => {
      if (row.data.customerId && row.data.name) {
        customerNames[row.data.customerId] = row.data.name;
      }
      return customerNames;
    }, {});
}

function getActiveBrand_(brandId) {
  const brand = readRows_(CONFIG.sheets.brands)
    .rows
    .map((row) => row.data)
    .find((row) => row.brandId === brandId && isActive_(row.active));

  return brand || null;
}

function getActiveOrdersForDate_(orderDate) {
  const customerNames = getCustomerNameMap_();

  return readRows_(CONFIG.sheets.orders)
    .rows
    .map((row) => row.data)
    .filter((order) => dateKey_(order.orderDate) === orderDate)
    .filter((order) => order.status !== "DELETED")
    .map((order) => {
      return {
        ...order,
        customerName: customerNames[order.customerId] || order.customerName,
      };
    });
}

function validateOrderInput_(orderDate, brand, quantityLitres) {
  if (!orderDate || !isDateKey_(orderDate)) {
    throw new Error("Valid order date is required.");
  }

  if (!brand) {
    throw new Error("Valid active milk brand is required.");
  }

  if (!(quantityLitres > 0) || !Number.isInteger(quantityLitres * 2)) {
    throw new Error("Quantity must be in 0.5 litre steps.");
  }
}

function validateCutoff_(orderDate) {
  if (!isDateKey_(orderDate)) {
    throw new Error("Valid order date is required.");
  }

  const deliveryDate = parseDateKey_(orderDate);
  const cutoff = new Date(deliveryDate);
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(CONFIG.cutoffHour, 0, 0, 0);

  if (new Date() > cutoff) {
    throw new Error("The 9 PM IST cutoff has passed for this delivery date.");
  }
}

function createSession_(role, account) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const session = {
    role,
    userId: role === "owner" ? account.ownerId : account.customerId,
    name: account.name,
    email: account.email || "",
    createdAt: new Date().toISOString(),
  };

  CacheService
    .getScriptCache()
    .put(`session:${token}`, JSON.stringify(session), CONFIG.sessionSeconds);

  return {
    token,
    ...session,
  };
}

function requireSession_(token, role) {
  const sessionText = CacheService.getScriptCache().get(`session:${token}`);

  if (!sessionText) {
    throw new Error("Login session expired. Please log in again.");
  }

  const session = JSON.parse(sessionText);
  if (role && session.role !== role) {
    throw new Error("This account is not allowed to perform this action.");
  }

  return session;
}

function verifyPassword_(password, salt, expectedHash) {
  return hashPassword_(password, salt) === expectedHash;
}

function hashPassword_(password, salt) {
  const rawText = password + salt;
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawText);

  return bytes
    .map((byte) => ("0" + (byte & 0xff).toString(16)).slice(-2))
    .join("");
}

function isActive_(value) {
  return value === true || String(value).toUpperCase() === "TRUE";
}

function isDateKey_(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function parseDateKey_(dateKey) {
  const parts = String(dateKey).split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function dateKey_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.timezone, "yyyy-MM-dd");
  }

  return String(value);
}

function getTomorrowDateKey_() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return Utilities.formatDate(tomorrow, CONFIG.timezone, "yyyy-MM-dd");
}

function nowText_() {
  return Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM-dd HH:mm:ss");
}

function orderResponse_(order) {
  return {
    orderId: order.orderId,
    customerId: order.customerId,
    customerName: order.customerName,
    orderDate: dateKey_(order.orderDate),
    brandId: order.brandId,
    brandName: order.brandName,
    quantityLitres: Number(order.quantityLitres),
    ratePerLitre: Number(order.ratePerLitre),
    amount: Number(order.amount),
    status: order.status,
  };
}

function getOwnerEmails_() {
  return readRows_(CONFIG.sheets.owners)
    .rows
    .map((row) => row.data)
    .filter((owner) => isActive_(owner.active))
    .map((owner) => owner.email)
    .filter(Boolean);
}

function getOwnerDashboardForSystem_(orderDate) {
  const orders = getActiveOrdersForDate_(orderDate);
  return {
    orderDate,
    orders,
    totalLitres: orders.reduce((sum, order) => sum + Number(order.quantityLitres), 0),
  };
}

function buildDailyReportBody_(dashboard) {
  const lines = [
    `Milk order report for ${dashboard.orderDate}`,
    "",
    `Total litres: ${dashboard.totalLitres}`,
    "",
    "Customer orders:",
  ];

  if (!dashboard.orders.length) {
    lines.push("No orders found.");
  } else {
    dashboard.orders.forEach((order) => {
      lines.push(
        `${order.customerName}: ${order.quantityLitres} L ${order.brandName} at Rs. ${order.ratePerLitre}/L`
      );
    });
  }

  return lines.join("\n");
}

function buildMonthlyReportBody_(orders, monthKey) {
  const customerTotals = {};

  orders.forEach((order) => {
    if (!customerTotals[order.customerId]) {
      customerTotals[order.customerId] = {
        name: order.customerName,
        quantityLitres: 0,
        amount: 0,
      };
    }

    customerTotals[order.customerId].quantityLitres += Number(order.quantityLitres);
    customerTotals[order.customerId].amount += Number(order.amount);
  });

  const lines = [`Monthly milk bills for ${monthKey}`, ""];
  Object.keys(customerTotals).forEach((customerId) => {
    const total = customerTotals[customerId];
    lines.push(`${total.name}: ${total.quantityLitres} L, Rs. ${total.amount}`);
  });

  if (Object.keys(customerTotals).length === 0) {
    lines.push("No orders found.");
  }

  return lines.join("\n");
}

function buildDailyBrandTotalRows_(orders) {
  const brandTotals = {};

  orders.forEach((order) => {
    if (!brandTotals[order.brandId]) {
      brandTotals[order.brandId] = {
        brandName: order.brandName,
        quantityLitres: 0,
        amount: 0,
      };
    }

    brandTotals[order.brandId].quantityLitres += Number(order.quantityLitres);
    brandTotals[order.brandId].amount += Number(order.amount);
  });

  return [
    ["Brand", "Total Litres", "Amount"],
    ...Object.keys(brandTotals).map((brandId) => {
      const total = brandTotals[brandId];
      return [total.brandName, total.quantityLitres, total.amount];
    }),
  ];
}

function buildDailyOrdersAndBrandTotalsRows_(orders) {
  return [
    ["Customer Orders"],
    ["Customer", "Brand", "Quantity Litres", "Rate Per Litre", "Amount"],
    ...orders.map((order) => [
      order.customerName,
      order.brandName,
      order.quantityLitres,
      order.ratePerLitre,
      order.amount,
    ]),
    [],
    ["Brand Totals"],
    ...buildDailyBrandTotalRows_(orders),
  ];
}

function buildMonthlyBillRows_(orders) {
  const customerTotals = {};

  orders.forEach((order) => {
    if (!customerTotals[order.customerId]) {
      customerTotals[order.customerId] = {
        customerName: order.customerName,
        quantityLitres: 0,
        amount: 0,
      };
    }

    customerTotals[order.customerId].quantityLitres += Number(order.quantityLitres);
    customerTotals[order.customerId].amount += Number(order.amount);
  });

  return [
    ["Customer ID", "Customer Name", "Total Litres", "Total Amount"],
    ...Object.keys(customerTotals).map((customerId) => {
      const total = customerTotals[customerId];
      return [customerId, total.customerName, total.quantityLitres, total.amount];
    }),
  ];
}

function buildCustomerBillRows_(orders, customer, startDate, endDate) {
  const totalLitres = orders.reduce((sum, order) => sum + Number(order.quantityLitres), 0);
  const totalAmount = orders.reduce((sum, order) => sum + Number(order.amount), 0);

  return [
    ["Customer Bill"],
    ["Customer ID", customer.customerId],
    ["Customer Name", customer.name],
    ["Start Date", startDate],
    ["End Date", endDate],
    [],
    ["Date", "Brand", "Quantity Litres", "Rate Per Litre", "Amount"],
    ...orders.map((order) => [
      dateKey_(order.orderDate),
      order.brandName,
      order.quantityLitres,
      order.ratePerLitre,
      order.amount,
    ]),
    [],
    ["Total Litres", totalLitres],
    ["Total Amount", totalAmount],
  ];
}

function createCsvAttachment_(fileName, rows) {
  const csv = rows.map((row) => {
    return row.map(csvCell_).join(",");
  }).join("\n");

  return Utilities.newBlob(csv, "text/csv", fileName);
}

function csvCell_(value) {
  const text = String(value === undefined || value === null ? "" : value);

  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function reportAlreadySent_(reportType, reportDate) {
  return readRows_(CONFIG.sheets.reportsLog)
    .rows
    .some((row) => {
      return row.data.reportType === reportType &&
        String(row.data.reportDate) === String(reportDate) &&
        row.data.status === "SENT";
    });
}

function logReport_(reportType, reportDate, status, message) {
  const table = readRows_(CONFIG.sheets.reportsLog);
  appendRow_(table.sheet, table.headers, {
    reportType,
    reportDate,
    sentAt: nowText_(),
    status,
    message,
  });
}
