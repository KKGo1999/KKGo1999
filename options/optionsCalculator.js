class OptionsCalculator {
    constructor() {
        this.riskFreeRate = 0.03; // 3% 无风险利率
    }
    
    // 标准正态分布累积分布函数
    normalCDF(x) {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        let probability = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        
        if (x > 0) {
            probability = 1 - probability;
        }
        
        return probability;
    }
    
    // Black-Scholes 期权定价模型
    calculateBlackScholes(type, spotPrice, strikePrice, timeToExpiryYears, volatility, dividend = 0) {
        const S = spotPrice;
        const K = strikePrice;
        const T = timeToExpiryYears;
        const r = this.riskFreeRate;
        const q = dividend;
        const sigma = volatility;
        
        const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
        const d2 = d1 - sigma * Math.sqrt(T);
        
        let price;
        if (type === 'call') {
            price = S * Math.exp(-q * T) * this.normalCDF(d1) - K * Math.exp(-r * T) * this.normalCDF(d2);
        } else { // put
            price = K * Math.exp(-r * T) * this.normalCDF(-d2) - S * Math.exp(-q * T) * this.normalCDF(-d1);
        }
        
        return price;
    }
    
    // 计算希腊字母
    calculateGreeks(type, spotPrice, strikePrice, timeToExpiryYears, volatility, dividend = 0) {
        const S = spotPrice;
        const K = strikePrice;
        const T = timeToExpiryYears;
        const r = this.riskFreeRate;
        const q = dividend;
        const sigma = volatility;
        
        const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
        const d2 = d1 - sigma * Math.sqrt(T);
        
        // 标准正态密度函数
        const nPrime = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
        
        // Delta
        let delta;
        if (type === 'call') {
            delta = Math.exp(-q * T) * this.normalCDF(d1);
        } else {
            delta = Math.exp(-q * T) * (this.normalCDF(d1) - 1);
        }
        
        // Gamma (calls和puts的gamma相同)
        const gamma = Math.exp(-q * T) * nPrime(d1) / (S * sigma * Math.sqrt(T));
        
        // Theta
        let theta;
        if (type === 'call') {
            theta = -S * sigma * Math.exp(-q * T) * nPrime(d1) / (2 * Math.sqrt(T)) 
                    - r * K * Math.exp(-r * T) * this.normalCDF(d2)
                    + q * S * Math.exp(-q * T) * this.normalCDF(d1);
        } else {
            theta = -S * sigma * Math.exp(-q * T) * nPrime(d1) / (2 * Math.sqrt(T)) 
                    + r * K * Math.exp(-r * T) * this.normalCDF(-d2)
                    - q * S * Math.exp(-q * T) * this.normalCDF(-d1);
        }
        theta = theta / 365; // 每日theta
        
        // Vega (calls和puts的vega相同)
        const vega = S * Math.exp(-q * T) * Math.sqrt(T) * nPrime(d1) / 100; // 波动率变化1%的价格变化
        
        // Rho
        let rho;
        if (type === 'call') {
            rho = K * T * Math.exp(-r * T) * this.normalCDF(d2) / 100;
        } else {
            rho = -K * T * Math.exp(-r * T) * this.normalCDF(-d2) / 100;
        }
        
        return { delta, gamma, theta, vega, rho };
    }
    
    // 计算隐含波动率(使用二分法)
    calculateImpliedVolatility(type, optionPrice, spotPrice, strikePrice, timeToExpiryYears, dividend = 0) {
        let low = 0.001;
        let high = 5.0;
        let mid, price;
        const MAX_ITERATIONS = 100;
        const PRECISION = 0.0001;
        
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            mid = (low + high) / 2;
            price = this.calculateBlackScholes(type, spotPrice, strikePrice, timeToExpiryYears, mid, dividend);
            
            if (Math.abs(price - optionPrice) < PRECISION) {
                return mid;
            }
            
            if (price > optionPrice) {
                high = mid;
            } else {
                low = mid;
            }
        }
        
        return mid; // 返回最接近的估计值
    }
    
    // 计算盈亏平衡点
    calculateBreakEven(type, strikePrice, premium) {
        if (type === 'call') {
            return strikePrice + premium;
        } else {
            return strikePrice - premium;
        }
    }
    
    // 计算最大收益/最大损失
    calculateProfitLoss(type, strikePrice, premium, isLong = true) {
        let maxLoss, maxProfit;
        
        if (type === 'call' && isLong) {
            // 买入看涨期权
            maxLoss = premium;
            maxProfit = 'unlimited';
        } else if (type === 'call' && !isLong) {
            // 卖出看涨期权
            maxProfit = premium;
            maxLoss = 'unlimited';
        } else if (type === 'put' && isLong) {
            // 买入看跌期权
            maxLoss = premium;
            maxProfit = strikePrice - premium;
        } else {
            // 卖出看跌期权
            maxProfit = premium;
            maxLoss = strikePrice - premium;
        }
        
        return { maxLoss, maxProfit };
    }
    
    // 计算价格变化对期权价值的影响
    calculatePriceImpact(type, spotPrice, strikePrice, timeToExpiryYears, volatility, priceRange = 0.2) {
        const priceImpact = [];
        const steps = 40;
        const priceLow = spotPrice * (1 - priceRange);
        const priceHigh = spotPrice * (1 + priceRange);
        const priceStep = (priceHigh - priceLow) / steps;
        
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            const optionPrice = this.calculateBlackScholes(type, price, strikePrice, timeToExpiryYears, volatility);
            priceImpact.push({ stockPrice: price, optionPrice });
        }
        
        return priceImpact;
    }
} 