const STORAGE_KEYS = {
  session: "milkmateSession",
  orders: "milkmateOrders",
  customers: "milkmateCustomers",
};

const LOCAL_BRANDS = [
  { brandId: "heritage", brandName: "Heritage Full Cream", ratePerLitre: 62 },
  { brandId: "nandini", brandName: "Nandini Toned Milk", ratePerLitre: 54 },
  { brandId: "amul", brandName: "Amul Gold", ratePerLitre: 66 },
];

let activeBrands = [...LOCAL_BRANDS];

document.addEventListener("DOMContentLoaded", () => {
  setupLoginPage();
  setupCustomerPage();
  setupOwnerPage();
  setupLogoutLinks();
});

function setupLoginPage() {
  const customerForm = document.querySelector("#customer-login-form");
  const ownerForm = document.querySelector("#owner-login-form");

  if (customerForm) {
    customerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await login({
        role: "customer",
        userId: document.querySelector("#customer-id").value.trim(),
        password: document.querySelector("#customer-password").value.trim(),
        messageId: "customer-login-message",
        nextPage: "customer.html",
      });
    });
  }

  if (ownerForm) {
    ownerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await login({
        role: "owner",
        userId: document.querySelector("#owner-id").value.trim(),
        password: document.querySelector("#owner-password").value.trim(),
        messageId: "owner-login-message",
        nextPage: "owner.html",
      });
    });
  }
}

async function login({ role, userId, password, messageId, nextPage }) {
  if (!userId || !password) {
    setMessageById(messageId, "Please enter user ID and password.", "error");
    return;
  }

  setMessageById(messageId, "Checking login...", "info");

  try {
    const response = await apiRequest("login", {
      role,
      userId,
      password,
    });

    if (!response.success) {
      setMessageById(messageId, response.message || "Login failed.", "error");
      return;
    }

    saveSession({
      role: response.role || role,
      userId: response.userId || userId,
      name: response.name || (role === "owner" ? "Owner" : formatCustomerName(userId)),
      token: response.token || "",
    });

    window.location.href = nextPage;
  } catch (error) {
    setMessageById(messageId, error.message, "error");
  }
}

async function setupCustomerPage() {
  const form = document.querySelector("#order-form");
  if (!form) {
    return;
  }

  let session = requireSession("customer");
  if (!session) {
    return;
  }

  const greeting = document.querySelector("#customer-greeting");
  const dateInput = document.querySelector("#order-date");
  const brandSelect = document.querySelector("#milk-brand");
  const quantityInput = document.querySelector("#quantity");
  const deleteButton = document.querySelector("#delete-order");

  session = await refreshProfile(session);
  greeting.textContent = `Welcome ${session.name}. Choose a delivery date, brand, and quantity. Orders can be changed before the 9 PM IST cutoff.`;
  dateInput.value = getTomorrowDateKey();

  await loadConfig(session);
  populateBrandDropdown();
  updateRateBox();
  await renderSelectedOrder();

  dateInput.addEventListener("change", renderSelectedOrder);
  brandSelect.addEventListener("change", () => {
    updateRateBox();
    updateOrderAmountMessage();
  });
  quantityInput.addEventListener("input", updateOrderAmountMessage);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveOrder(session);
  });

  deleteButton.addEventListener("click", async () => {
    await deleteOrder(session);
  });
}

async function setupOwnerPage() {
  const ordersBody = document.querySelector("#owner-orders-body");
  if (!ordersBody) {
    return;
  }

  const session = requireSession("owner");
  if (!session) {
    return;
  }

  await renderOwnerDashboard(session);
  setupCustomerAdmin(session);
  await renderCustomers(session);
}

function setupLogoutLinks() {
  document.querySelectorAll("[data-logout]").forEach((link) => {
    link.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEYS.session);
    });
  });
}

async function loadConfig(session) {
  const response = await apiRequest("getConfig", {
    token: session.token,
  });

  if (response.success && Array.isArray(response.brands)) {
    activeBrands = response.brands.map(normalizeBrand);
  }
}

async function refreshProfile(session) {
  const response = await apiRequest("getProfile", {
    token: session.token,
  });

  if (!response.success) {
    return session;
  }

  const updatedSession = {
    ...session,
    name: response.name || session.name,
  };

  saveSession(updatedSession);
  return updatedSession;
}

function populateBrandDropdown() {
  const brandSelect = document.querySelector("#milk-brand");
  brandSelect.innerHTML = '<option value="">Select brand</option>';

  activeBrands.forEach((brand) => {
    const option = document.createElement("option");
    option.value = brand.brandId;
    option.textContent = brand.brandName;
    brandSelect.appendChild(option);
  });
}

async function saveOrder(session) {
  const date = document.querySelector("#order-date").value;
  const brandId = document.querySelector("#milk-brand").value;
  const quantity = Number(document.querySelector("#quantity").value);
  const brand = getBrandById(brandId);

  if (!date || !brand || !isValidQuantity(quantity)) {
    setMessage("Please select a date, brand, and quantity in 0.5 litre steps.", "error");
    return;
  }

  setMessage("Saving order...", "info");

  const response = await apiRequest("upsertOrder", {
    token: session.token,
    orderDate: date,
    brandId,
    quantityLitres: quantity,
  });

  if (!response.success) {
    setMessage(response.message || "Order could not be saved.", "error");
    return;
  }

  await renderSelectedOrder();
  setMessage(`Order saved: ${quantity} L ${brand.brandName} for ${formatDate(date)}.`, "success");
}

async function deleteOrder(session) {
  const date = document.querySelector("#order-date").value;

  if (!date) {
    setMessage("Please select a date before deleting an order.", "error");
    return;
  }

  setMessage("Deleting order...", "info");

  const response = await apiRequest("deleteOrder", {
    token: session.token,
    orderDate: date,
  });

  if (!response.success) {
    setMessage(response.message || "Order could not be deleted.", "error");
    return;
  }

  clearOrderInputs(false);
  await renderSelectedOrder();
  setMessage(`Order deleted for ${formatDate(date)}.`, "success");
}

async function renderSelectedOrder() {
  const session = getSession();
  const date = document.querySelector("#order-date").value;
  const title = document.querySelector("#summary-title");
  const detail = document.querySelector("#summary-detail");

  if (!date) {
    title.textContent = "No date selected";
    detail.textContent = "Select a delivery date to view or manage the order.";
    return;
  }

  const order = await getCustomerOrder(session, date);

  if (!order) {
    title.textContent = `No order for ${formatDate(date)}`;
    detail.textContent = "You can create a new order for this date if the cutoff has not passed.";
    clearOrderInputs(false);
    return;
  }

  document.querySelector("#milk-brand").value = order.brandId;
  document.querySelector("#quantity").value = order.quantityLitres;
  updateRateBox();

  title.textContent = `${formatNumber(order.quantityLitres)} L ${order.brandName}`;
  detail.textContent = `Rate Rs. ${formatNumber(order.ratePerLitre)}/L, amount Rs. ${formatNumber(order.amount)}.`;
}

async function renderOwnerDashboard(session) {
  const response = await apiRequest("getOwnerDashboard", {
    token: session.token,
    orderDate: getTomorrowDateKey(),
  });

  if (!response.success) {
    renderOwnerOrders([]);
    renderBrandTotals([]);
    return;
  }

  document.querySelector("#owner-total-litres").textContent =
    `${formatNumber(response.totalLitres || 0)} L`;
  document.querySelector("#owner-active-orders").textContent = response.orderCount || 0;
  renderOwnerOrders((response.orders || []).map(normalizeOrder));
  renderBrandTotals(response.brandTotals || []);
}

function renderOwnerOrders(orders) {
  const ordersBody = document.querySelector("#owner-orders-body");

  if (!orders.length) {
    ordersBody.innerHTML = '<tr><td colspan="4">No customer orders found for tomorrow.</td></tr>';
    return;
  }

  ordersBody.innerHTML = orders
    .map(
      (order) => `
        <tr>
          <td>${escapeHtml(order.customerName)}</td>
          <td>${escapeHtml(order.brandName)}</td>
          <td>${formatNumber(order.quantityLitres)} L</td>
          <td>Rs. ${formatNumber(order.amount)}</td>
        </tr>
      `
    )
    .join("");
}

function renderBrandTotals(brandTotals) {
  const brandBody = document.querySelector("#owner-brand-body");

  if (!brandTotals.length) {
    brandBody.innerHTML = '<tr><td colspan="3">No brand totals available yet.</td></tr>';
    return;
  }

  brandBody.innerHTML = brandTotals
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.brandName)}</td>
          <td>${formatNumber(item.quantityLitres)} L</td>
          <td>Rs. ${formatNumber(item.ratePerLitre)}/L</td>
        </tr>
      `
    )
    .join("");
}

function setupCustomerAdmin(session) {
  const form = document.querySelector("#customer-admin-form");
  const clearButton = document.querySelector("#clear-customer-form");
  const deleteButton = document.querySelector("#delete-customer");

  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCustomer(session);
  });

  clearButton.addEventListener("click", clearCustomerForm);

  deleteButton.addEventListener("click", async () => {
    await deleteCustomer(session);
  });
}

async function renderCustomers(session) {
  const response = await apiRequest("listCustomers", {
    token: session.token,
  });
  const customersBody = document.querySelector("#customers-body");

  if (!response.success || !response.customers || !response.customers.length) {
    customersBody.innerHTML = '<tr><td colspan="4">No customers found.</td></tr>';
    return;
  }

  customersBody.innerHTML = response.customers
    .map((customer) => `
      <tr data-customer-id="${escapeHtml(customer.customerId)}">
        <td>${escapeHtml(customer.customerId)}</td>
        <td>${escapeHtml(customer.name)}</td>
        <td>${escapeHtml(customer.phone || "")}</td>
        <td>${customer.active ? "Active" : "Inactive"}</td>
      </tr>
    `)
    .join("");

  customersBody.querySelectorAll("tr[data-customer-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const customer = response.customers.find((item) => item.customerId === row.dataset.customerId);
      fillCustomerForm(customer);
    });
  });
}

async function saveCustomer(session) {
  const customer = getCustomerFormValues();

  if (!customer.customerId || !customer.name) {
    setMessageById("customer-admin-message", "Customer ID and name are required.", "error");
    return;
  }

  setMessageById("customer-admin-message", "Saving customer...", "info");

  const response = await apiRequest("saveCustomer", {
    token: session.token,
    ...customer,
  });

  if (!response.success) {
    setMessageById("customer-admin-message", response.message || "Customer could not be saved.", "error");
    return;
  }

  clearCustomerForm();
  await renderCustomers(session);
  setMessageById("customer-admin-message", response.message || "Customer saved.", "success");
}

async function deleteCustomer(session) {
  const customerId = document.querySelector("#admin-customer-id").value.trim();

  if (!customerId) {
    setMessageById("customer-admin-message", "Select or enter a customer ID first.", "error");
    return;
  }

  setMessageById("customer-admin-message", "Deleting customer...", "info");

  const response = await apiRequest("deleteCustomer", {
    token: session.token,
    customerId,
  });

  if (!response.success) {
    setMessageById("customer-admin-message", response.message || "Customer could not be deleted.", "error");
    return;
  }

  clearCustomerForm();
  await renderCustomers(session);
  setMessageById("customer-admin-message", response.message || "Customer deleted.", "success");
}

function fillCustomerForm(customer) {
  document.querySelector("#admin-customer-id").value = customer.customerId || "";
  document.querySelector("#admin-customer-name").value = customer.name || "";
  document.querySelector("#admin-customer-phone").value = customer.phone || "";
  document.querySelector("#admin-customer-password").value = "";
  document.querySelector("#admin-customer-active").value = customer.active ? "TRUE" : "FALSE";
  setMessageById("customer-admin-message", "Editing selected customer. Enter a password only if changing it.", "info");
}

function clearCustomerForm() {
  document.querySelector("#customer-admin-form").reset();
  document.querySelector("#admin-customer-active").value = "TRUE";
  setMessageById("customer-admin-message", "", "");
}

function getCustomerFormValues() {
  return {
    customerId: document.querySelector("#admin-customer-id").value.trim(),
    name: document.querySelector("#admin-customer-name").value.trim(),
    phone: document.querySelector("#admin-customer-phone").value.trim(),
    password: document.querySelector("#admin-customer-password").value,
    active: document.querySelector("#admin-customer-active").value === "TRUE",
  };
}

function updateRateBox() {
  const brand = getBrandById(document.querySelector("#milk-brand").value);
  const rateText = document.querySelector("#selected-rate");
  rateText.textContent = brand ? `Rs. ${brand.ratePerLitre} / litre` : "Select a brand";
}

function updateOrderAmountMessage() {
  const brand = getBrandById(document.querySelector("#milk-brand").value);
  const quantity = Number(document.querySelector("#quantity").value);

  if (!brand || !isValidQuantity(quantity)) {
    setMessage("", "");
    return;
  }

  setMessage(`Current amount: Rs. ${formatNumber(quantity * brand.ratePerLitre)}`, "info");
}

function clearOrderInputs(clearDate = true) {
  if (clearDate) {
    document.querySelector("#order-date").value = "";
  }
  document.querySelector("#milk-brand").value = "";
  document.querySelector("#quantity").value = "";
  updateRateBox();
}

async function getCustomerOrder(session, date) {
  const response = await apiRequest("getCustomerOrders", {
    token: session.token,
    orderDate: date,
  });

  if (!response.success || !response.orders || !response.orders.length) {
    return null;
  }

  return normalizeOrder(response.orders[0]);
}

async function apiRequest(action, payload = {}) {
  if (!isBackendConfigured()) {
    return localApiRequest(action, payload);
  }

  const response = await fetch(window.MILKMATE_CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  });

  if (!response.ok) {
    throw new Error("Backend request failed. Check Apps Script deployment access.");
  }

  return response.json();
}

function localApiRequest(action, payload) {
  if (action === "login") {
    const role = payload.role;
    const userId = payload.userId;
    return Promise.resolve({
      success: true,
      token: `local-${role}-${Date.now()}`,
      role,
      userId,
      name: role === "owner" ? "Owner" : formatCustomerName(userId),
    });
  }

  if (action === "getConfig") {
    return Promise.resolve({
      success: true,
      brands: LOCAL_BRANDS,
    });
  }

  if (action === "getCustomerOrders") {
    const session = getSession();
    const orders = getOrders()
      .filter((order) => order.customerId === session.userId)
      .filter((order) => !payload.orderDate || order.orderDate === payload.orderDate);
    return Promise.resolve({
      success: true,
      orders,
    });
  }

  if (action === "upsertOrder") {
    const session = getSession();
    const brand = getBrandById(payload.brandId);
    const quantityLitres = Number(payload.quantityLitres);
    const amount = quantityLitres * brand.ratePerLitre;
    const orders = getOrders();
    const existingIndex = orders.findIndex((order) => {
      return order.customerId === session.userId && order.orderDate === payload.orderDate;
    });
    const order = {
      orderId: `${session.userId}-${payload.orderDate}`,
      customerId: session.userId,
      customerName: session.name,
      orderDate: payload.orderDate,
      brandId: brand.brandId,
      brandName: brand.brandName,
      quantityLitres,
      ratePerLitre: brand.ratePerLitre,
      amount,
      status: "ACTIVE",
    };

    if (existingIndex >= 0) {
      orders[existingIndex] = order;
    } else {
      orders.push(order);
    }

    saveOrders(orders);
    return Promise.resolve({
      success: true,
      order,
    });
  }

  if (action === "deleteOrder") {
    const session = getSession();
    const orders = getOrders();
    const filteredOrders = orders.filter((order) => {
      return !(order.customerId === session.userId && order.orderDate === payload.orderDate);
    });

    saveOrders(filteredOrders);
    return Promise.resolve({
      success: filteredOrders.length !== orders.length,
      message: filteredOrders.length === orders.length ? "No active order found for this date." : "Order deleted.",
    });
  }

  if (action === "getOwnerDashboard") {
    const orders = getOrders().filter((order) => order.orderDate === payload.orderDate);
    const brandTotals = Object.values(getBrandTotals(orders));
    return Promise.resolve({
      success: true,
      orders,
      brandTotals,
      totalLitres: orders.reduce((sum, order) => sum + Number(order.quantityLitres), 0),
      orderCount: orders.length,
    });
  }

  if (action === "listCustomers") {
    return Promise.resolve({
      success: true,
      customers: getLocalCustomers(),
    });
  }

  if (action === "saveCustomer") {
    const customers = getLocalCustomers();
    const existingIndex = customers.findIndex((customer) => customer.customerId === payload.customerId);
    const customer = {
      customerId: payload.customerId,
      name: payload.name,
      phone: payload.phone || "",
      active: payload.active !== false,
    };

    if (existingIndex >= 0) {
      customers[existingIndex] = customer;
    } else {
      customers.push(customer);
    }

    saveLocalCustomers(customers);
    return Promise.resolve({
      success: true,
      message: existingIndex >= 0 ? "Customer updated." : "Customer added.",
    });
  }

  if (action === "deleteCustomer") {
    const customers = getLocalCustomers().map((customer) => {
      if (customer.customerId !== payload.customerId) {
        return customer;
      }

      return {
        ...customer,
        active: false,
      };
    });

    saveLocalCustomers(customers);
    return Promise.resolve({
      success: true,
      message: "Customer deactivated.",
    });
  }

  return Promise.resolve({
    success: false,
    message: "Unknown local action.",
  });
}

function getBrandTotals(orders) {
  return orders.reduce((totals, order) => {
    if (!totals[order.brandId]) {
      totals[order.brandId] = {
        brandId: order.brandId,
        brandName: order.brandName,
        quantityLitres: 0,
        ratePerLitre: Number(order.ratePerLitre),
      };
    }

    totals[order.brandId].quantityLitres += Number(order.quantityLitres);
    return totals;
  }, {});
}

function normalizeBrand(brand) {
  return {
    brandId: brand.brandId || brand.id,
    brandName: brand.brandName || brand.name,
    ratePerLitre: Number(brand.ratePerLitre || brand.rate),
  };
}

function normalizeOrder(order) {
  return {
    orderId: order.orderId || order.id,
    customerId: order.customerId,
    customerName: order.customerName,
    orderDate: order.orderDate || order.date,
    brandId: order.brandId,
    brandName: order.brandName,
    quantityLitres: Number(order.quantityLitres || order.quantity),
    ratePerLitre: Number(order.ratePerLitre || order.rate),
    amount: Number(order.amount),
  };
}

function isBackendConfigured() {
  return Boolean(
    window.MILKMATE_CONFIG &&
    window.MILKMATE_CONFIG.APPS_SCRIPT_URL &&
    window.MILKMATE_CONFIG.APPS_SCRIPT_URL.startsWith("https://")
  );
}

function getBrandById(brandId) {
  return activeBrands.find((brand) => brand.brandId === brandId);
}

function isValidQuantity(quantity) {
  return quantity > 0 && Number.isInteger(quantity * 2);
}

function getOrders() {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.orders) || "[]");
}

function saveOrders(orders) {
  localStorage.setItem(STORAGE_KEYS.orders, JSON.stringify(orders));
}

function getLocalCustomers() {
  const savedCustomers = JSON.parse(localStorage.getItem(STORAGE_KEYS.customers) || "null");

  if (savedCustomers) {
    return savedCustomers;
  }

  return [
    {
      customerId: "CUST001",
      name: "Sample Customer",
      phone: "9876543210",
      active: true,
    },
  ];
}

function saveLocalCustomers(customers) {
  localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customers));
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
}

function getSession() {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.session) || "null");
}

function requireSession(role) {
  const session = getSession();

  if (!session || session.role !== role) {
    window.location.href = "index.html";
    return null;
  }

  return session;
}

function getTomorrowDateKey() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return toDateKey(tomorrow);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(dateKey) {
  return parseDateKey(dateKey).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatCustomerName(userId) {
  return userId
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function setMessage(text, type) {
  setMessageById("order-message", text, type);
}

function setMessageById(id, text, type) {
  const message = document.querySelector(`#${id}`);
  if (!message) {
    return;
  }

  message.textContent = text;
  message.className = `form-message ${type || ""}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
