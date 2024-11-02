const { v4: uuidv4 } = require("uuid");
const Razorpay = require("razorpay");
require("dotenv").config();

const { JWT_SECRET, RAZOR_PAY_key_id, RAZOR_PAY_key_secret } = process.env;

// Check for Razorpay keys
if (!RAZOR_PAY_key_id || !RAZOR_PAY_key_secret) {
  console.error("Razorpay keys are missing in the environment variables.");
  process.exit(1);
}

// Razorpay Instance
const razorpay = new Razorpay({
  key_id: RAZOR_PAY_key_id,
  key_secret: RAZOR_PAY_key_secret,
});

const { customerModel, orderModel, productModel, walletModel, couponModel, cartModel, addressModel } = require("../../Model");

// Place order with COD
const getPlaceOrderCOD = async (req, res) => {
  try {
    console.log("Processing COD order...");
    const { grantTotal, couponCode } = req.query;
    const user = await customerModel.findOne({ email: req.user });
    if (!user) throw new Error("User not found.");

    const coupon = await couponModel.findOne({ couponCode });
    const discountAmount = coupon ? coupon.amount : 0;

    const cart = await cartModel.findOne({ userId: user._id }).populate({
      path: "products.productId",
      model: "Product",
    });
    if (!cart) throw new Error("Cart not found.");

    const address = await addressModel.findOne({ "address._id": req.query.addressId }, { "address.$": 1 });
    if (!address) throw new Error("Address not found.");

    let totalAmount = 0;
    const productArray = cart.products.map((product) => {
      totalAmount += product.quantity * product.productId.salePrice;
      return {
        productId: product.productId._id,
        quantity: product.quantity,
        price: product.productId.salePrice,
      };
    });

    await orderModel.create({
      customerId: user._id,
      products: productArray,
      address: address.address[0],
      paymentMethod: "COD",
      referenceId: uuidv4(),
      shippingCharge: 0,
      discount: discountAmount,
      totalAmount: grantTotal,
      createdOn: Date.now(),
      orderStatus: "Order Placed",
      paymentStatus: "Pending",
      deliveredOn: new Date(),
      couponCode,
    });

    // Decrease product stock
    for (const product of cart.products) {
      await productModel.updateOne(
        { _id: product.productId._id },
        { $inc: { units: -product.quantity } }
      );
    }

    await cartModel.deleteOne({ userId: user._id });
    res.render("order-placed");
  } catch (error) {
    console.error("Error placing COD order:", error);
    res.status(500).send("Failed to place order");
  }
};

// Place order with online payment
const getPlaceOrderOnline = async (req, res) => {
  try {
    console.log("Processing online order...");
    const { grantTotal, couponCode } = req.query;

    const user = await customerModel.findOne({ email: req.user });
    if (!user) throw new Error("User not found.");

    const cart = await cartModel.findOne({ userId: user._id }).populate({
      path: "products.productId",
      model: "Product",
    });
    if (!cart) throw new Error("Cart not found.");

    const address = await addressModel.findOne({ "address._id": req.query.addressId }, { "address.$": 1 });
    if (!address) throw new Error("Address not found.");

    let totalAmount = 0;
    const productArray = cart.products.map((product) => {
      totalAmount += product.quantity * product.productId.salePrice;
      return {
        productId: product.productId._id,
        quantity: product.quantity,
        price: product.productId.salePrice,
      };
    });

    const options = {
      amount: grantTotal * 100,
      currency: "INR",
      receipt: uuidv4(),
      payment_capture: "1",
    };

    const newOrder = await razorpay.orders.create(options);

    await orderModel.create({
      customerId: user._id,
      products: productArray,
      address: address.address[0],
      paymentMethod: "Online",
      referenceId: newOrder.id,
      shippingCharge: 0,
      discount: 0,
      totalAmount: grantTotal,
      createdOn: Date.now(),
      orderStatus: "Order Placed",
      paymentStatus: "Pending",
      deliveredOn: new Date(),
      couponCode,
    });

    for (const product of cart.products) {
      await productModel.updateOne(
        { _id: product.productId._id },
        { $inc: { units: -product.quantity } }
      );
    }

    await cartModel.deleteOne({ userId: user._id });
    res.status(200).json({ order_id: newOrder.id });
  } catch (error) {
    console.error("Error placing online order:", error);
    res.status(500).json({ error: "Failed to place online order" });
  }
};

// Update payment status
const postUpdatePaymentStatus = async (req, res) => {
  try {
    const { paymentStatus, orderId, couponCode } = req.query;
    const coupon = await couponModel.findOne({ couponCode });
    const discountAmount = coupon ? coupon.amount : 0;

    const updateFields = { paymentStatus, discount: discountAmount };
    if (paymentStatus === "Failure") {
      const order = await orderModel.findOne({ referenceId: orderId });
      for (const item of order.products) {
        await productModel.updateOne(
          { _id: item.productId },
          { $inc: { units: item.quantity } }
        );
      }
    }
    await orderModel.updateOne({ referenceId: orderId }, { $set: updateFields });
    res.redirect("/profile");
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({ error: "Failed to update payment status" });
  }
};

// Display invoice page
const getInvoice = async (req, res) => {
  try {
    const orderId = req.query.orderId;
    const order = await orderModel.findOne({ _id: orderId }).populate({
      path: "products.productId",
      model: "Product",
    });
    const isLogin = req.cookies.isLogin;
    res.render("invoice", { isLogin, order });
  } catch (error) {
    console.error("Error fetching invoice:", error);
    res.status(500).send("Failed to load invoice");
  }
};

// Cancel order
const getOrderCancel = async (req, res) => {
  try {
    const user = await customerModel.findOne({ email: req.user });
    const orderId = req.query.orderId;
    await orderModel.updateOne({ _id: orderId }, { $set: { orderStatus: "Canceled" } });

    const order = await orderModel.findOne({ _id: orderId });
    for (const product of order.products) {
      await productModel.updateOne(
        { _id: product.productId },
        { $inc: { units: product.quantity } }
      );
    }

    const wallet = await walletModel.findOne({ userId: user._id });
    if (order.paymentStatus === "Success") {
      await walletModel.updateOne(
        { userId: user._id },
        { $set: { amount: (wallet.amount || 0) + order.totalAmount } }
      );
    }

    res.redirect("/profile");
  } catch (error) {
    console.error("Error cancelling order:", error);
    res.status(500).send("Failed to cancel order");
  }
};

// Return order
const getOrderReturn = async (req, res) => {
  try {
    const user = await customerModel.findOne({ email: req.user });
    const orderId = req.query.orderId;
    await orderModel.updateOne({ _id: orderId }, { $set: { orderStatus: "Returned" } });

    const order = await orderModel.findOne({ _id: orderId });
    for (const product of order.products) {
      await productModel.updateOne(
        { _id: product.productId },
        { $inc: { units: product.quantity } }
      );
    }

    const wallet = await walletModel.findOne({ userId: user._id });
    if (order.paymentStatus === "Success") {
      await walletModel.updateOne(
        { userId: user._id },
        { $set: { amount: (wallet.amount || 0) + order.totalAmount } }
      );
    }

    res.redirect("/profile");
  } catch (error) {
    console.error("Error returning order:", error);
    res.status(500).send("Failed to return order");
  }
};

module.exports = {
  getPlaceOrderCOD,
  getPlaceOrderOnline,
  postUpdatePaymentStatus,
  getInvoice,
  getOrderCancel,
  getOrderReturn,
};
