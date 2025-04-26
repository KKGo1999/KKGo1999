class OptionStrategies {
    constructor(optionsCalculator) {
        this.optionsCalculator = optionsCalculator;
    }
    
    // 计算垂直价差策略
    calculateVerticalSpread(spreadType, underlyingPrice, strikes, expirationDays, volatility, riskFreeRate = 0.03) {
        const timeToExpiryYears = expirationDays / 365;
        
        // 获取期权类型和买入/卖出配置
        let longOptionType, shortOptionType;
        let longStrike, shortStrike;
        
        if (spreadType === 'bullCallSpread') {
            // 牛市看涨价差：买入低执行价看涨，卖出高执行价看涨
            longOptionType = 'call';
            shortOptionType = 'call';
            longStrike = Math.min(...strikes);
            shortStrike = Math.max(...strikes);
        } else if (spreadType === 'bearCallSpread') {
            // 熊市看涨价差：卖出低执行价看涨，买入高执行价看涨
            longOptionType = 'call';
            shortOptionType = 'call';
            longStrike = Math.max(...strikes);
            shortStrike = Math.min(...strikes);
        } else if (spreadType === 'bullPutSpread') {
            // 牛市看跌价差：卖出高执行价看跌，买入低执行价看跌
            longOptionType = 'put';
            shortOptionType = 'put';
            longStrike = Math.min(...strikes);
            shortStrike = Math.max(...strikes);
        } else if (spreadType === 'bearPutSpread') {
            // 熊市看跌价差：买入高执行价看跌，卖出低执行价看跌
            longOptionType = 'put';
            shortOptionType = 'put';
            longStrike = Math.max(...strikes);
            shortStrike = Math.min(...strikes);
        } else {
            throw new Error('不支持的价差策略类型');
        }
        
        // 计算期权价格
        const longOptionPrice = this.optionsCalculator.calculateBlackScholes(
            longOptionType, 
            underlyingPrice, 
            longStrike, 
            timeToExpiryYears, 
            volatility
        );
        
        const shortOptionPrice = this.optionsCalculator.calculateBlackScholes(
            shortOptionType, 
            underlyingPrice, 
            shortStrike, 
            timeToExpiryYears, 
            volatility
        );
        
        // 计算策略净成本/收益
        const netCost = (spreadType === 'bullCallSpread' || spreadType === 'bearPutSpread') 
            ? longOptionPrice - shortOptionPrice 
            : shortOptionPrice - longOptionPrice;
        
        // 计算最大盈利和最大亏损
        let maxProfit, maxLoss;
        if (spreadType === 'bullCallSpread') {
            maxProfit = shortStrike - longStrike - netCost;
            maxLoss = netCost;
        } else if (spreadType === 'bearCallSpread') {
            maxProfit = netCost;
            maxLoss = longStrike - shortStrike - netCost;
        } else if (spreadType === 'bullPutSpread') {
            maxProfit = netCost;
            maxLoss = shortStrike - longStrike - netCost;
        } else if (spreadType === 'bearPutSpread') {
            maxProfit = shortStrike - longStrike - netCost;
            maxLoss = netCost;
        }
        
        // 计算盈亏平衡点
        let breakEven;
        if (spreadType === 'bullCallSpread') {
            breakEven = longStrike + netCost;
        } else if (spreadType === 'bearCallSpread') {
            breakEven = shortStrike + netCost;
        } else if (spreadType === 'bullPutSpread') {
            breakEven = shortStrike - netCost;
        } else if (spreadType === 'bearPutSpread') {
            breakEven = longStrike - netCost;
        }
        
        // 计算策略收益曲线
        const priceRange = 0.3; // 股价波动范围
        const priceLow = underlyingPrice * (1 - priceRange);
        const priceHigh = underlyingPrice * (1 + priceRange);
        const steps = 40;
        const priceStep = (priceHigh - priceLow) / steps;
        
        const payoffCurve = [];
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            let payoff;
            
            if (spreadType === 'bullCallSpread') {
                const longPayoff = Math.max(0, price - longStrike);
                const shortPayoff = -Math.max(0, price - shortStrike);
                payoff = longPayoff + shortPayoff - netCost;
            } else if (spreadType === 'bearCallSpread') {
                const longPayoff = Math.max(0, price - longStrike);
                const shortPayoff = -Math.max(0, price - shortStrike);
                payoff = longPayoff + shortPayoff + netCost;
            } else if (spreadType === 'bullPutSpread') {
                const longPayoff = Math.max(0, longStrike - price);
                const shortPayoff = -Math.max(0, shortStrike - price);
                payoff = longPayoff + shortPayoff + netCost;
            } else if (spreadType === 'bearPutSpread') {
                const longPayoff = Math.max(0, longStrike - price);
                const shortPayoff = -Math.max(0, shortStrike - price);
                payoff = longPayoff + shortPayoff - netCost;
            }
            
            payoffCurve.push({
                stockPrice: price,
                payoff: payoff
            });
        }
        
        return {
            strategy: spreadType,
            longOption: {
                type: longOptionType,
                strike: longStrike,
                price: longOptionPrice
            },
            shortOption: {
                type: shortOptionType,
                strike: shortStrike,
                price: shortOptionPrice
            },
            netCost: netCost,
            maxProfit: maxProfit,
            maxLoss: maxLoss,
            breakEven: breakEven,
            payoffCurve: payoffCurve
        };
    }
    
    // 计算铁鹰/铁蝶策略
    calculateIronCondor(underlyingPrice, strikes, expirationDays, volatility, riskFreeRate = 0.03) {
        if (strikes.length !== 4) {
            throw new Error('铁鹰策略需要四个执行价');
        }
        
        // 对执行价排序
        const sortedStrikes = [...strikes].sort((a, b) => a - b);
        const [put1, put2, call1, call2] = sortedStrikes;
        
        const timeToExpiryYears = expirationDays / 365;
        
        // 买入外侧看跌期权
        const longPutPrice = this.optionsCalculator.calculateBlackScholes(
            'put', underlyingPrice, put1, timeToExpiryYears, volatility
        );
        
        // 卖出内侧看跌期权
        const shortPutPrice = this.optionsCalculator.calculateBlackScholes(
            'put', underlyingPrice, put2, timeToExpiryYears, volatility
        );
        
        // 卖出内侧看涨期权
        const shortCallPrice = this.optionsCalculator.calculateBlackScholes(
            'call', underlyingPrice, call1, timeToExpiryYears, volatility
        );
        
        // 买入外侧看涨期权
        const longCallPrice = this.optionsCalculator.calculateBlackScholes(
            'call', underlyingPrice, call2, timeToExpiryYears, volatility
        );
        
        // 计算净收入/成本
        const netCredit = (shortPutPrice + shortCallPrice) - (longPutPrice + longCallPrice);
        
        // 计算最大收益和最大亏损
        const maxProfit = netCredit;
        const maxLossPut = (put2 - put1) - netCredit;
        const maxLossCall = (call2 - call1) - netCredit;
        const maxLoss = Math.max(maxLossPut, maxLossCall);
        
        // 计算盈亏平衡点
        const breakEvenLow = put2 - netCredit;
        const breakEvenHigh = call1 + netCredit;
        
        // 计算收益曲线
        const priceRange = 0.4; // 更大的价格范围
        const priceLow = underlyingPrice * (1 - priceRange);
        const priceHigh = underlyingPrice * (1 + priceRange);
        const steps = 50;
        const priceStep = (priceHigh - priceLow) / steps;
        
        const payoffCurve = [];
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            const longPutPayoff = Math.max(0, put1 - price);
            const shortPutPayoff = -Math.max(0, put2 - price);
            const shortCallPayoff = -Math.max(0, price - call1);
            const longCallPayoff = Math.max(0, price - call2);
            
            const payoff = longPutPayoff + shortPutPayoff + shortCallPayoff + longCallPayoff + netCredit;
            
            payoffCurve.push({
                stockPrice: price,
                payoff: payoff
            });
        }
        
        return {
            strategy: 'ironCondor',
            legs: [
                { type: 'put', strike: put1, position: 'long', price: longPutPrice },
                { type: 'put', strike: put2, position: 'short', price: shortPutPrice },
                { type: 'call', strike: call1, position: 'short', price: shortCallPrice },
                { type: 'call', strike: call2, position: 'long', price: longCallPrice }
            ],
            netCredit: netCredit,
            maxProfit: maxProfit,
            maxLoss: maxLoss,
            breakEvenLow: breakEvenLow,
            breakEvenHigh: breakEvenHigh,
            payoffCurve: payoffCurve
        };
    }
    
    // 计算蝶式策略
    calculateButterfly(butterflyType, underlyingPrice, strikes, expirationDays, volatility, riskFreeRate = 0.03) {
        if (strikes.length !== 3) {
            throw new Error('蝶式策略需要三个执行价');
        }
        
        // 对执行价排序
        const sortedStrikes = [...strikes].sort((a, b) => a - b);
        const [strike1, strike2, strike3] = sortedStrikes;
        
        // 检查执行价是否等距
        const diff1 = Math.round((strike2 - strike1) * 100) / 100;
        const diff2 = Math.round((strike3 - strike2) * 100) / 100;
        if (Math.abs(diff1 - diff2) > 0.01) {
            console.warn('警告：蝶式策略一般使用等距执行价');
        }
        
        const timeToExpiryYears = expirationDays / 365;
        const optionType = butterflyType === 'callButterfly' ? 'call' : 'put';
        
        // 买入低执行价期权
        const option1Price = this.optionsCalculator.calculateBlackScholes(
            optionType, underlyingPrice, strike1, timeToExpiryYears, volatility
        );
        
        // 卖出中间执行价期权 (两份)
        const option2Price = this.optionsCalculator.calculateBlackScholes(
            optionType, underlyingPrice, strike2, timeToExpiryYears, volatility
        );
        
        // 买入高执行价期权
        const option3Price = this.optionsCalculator.calculateBlackScholes(
            optionType, underlyingPrice, strike3, timeToExpiryYears, volatility
        );
        
        // 计算净成本
        const netCost = option1Price + option3Price - (2 * option2Price);
        
        // 计算最大收益和最大亏损
        const maxProfit = (strike2 - strike1) - netCost;
        const maxLoss = netCost;
        
        // 计算盈亏平衡点
        const breakEvenLow = strike1 + netCost;
        const breakEvenHigh = strike3 - netCost;
        
        // 计算收益曲线
        const priceRange = 0.3;
        const priceLow = underlyingPrice * (1 - priceRange);
        const priceHigh = underlyingPrice * (1 + priceRange);
        const steps = 40;
        const priceStep = (priceHigh - priceLow) / steps;
        
        const payoffCurve = [];
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            let payoff;
            
            if (butterflyType === 'callButterfly') {
                const option1Payoff = Math.max(0, price - strike1);
                const option2Payoff = -2 * Math.max(0, price - strike2);
                const option3Payoff = Math.max(0, price - strike3);
                payoff = option1Payoff + option2Payoff + option3Payoff - netCost;
            } else {
                const option1Payoff = Math.max(0, strike1 - price);
                const option2Payoff = -2 * Math.max(0, strike2 - price);
                const option3Payoff = Math.max(0, strike3 - price);
                payoff = option1Payoff + option2Payoff + option3Payoff - netCost;
            }
            
            payoffCurve.push({
                stockPrice: price,
                payoff: payoff
            });
        }
        
        return {
            strategy: butterflyType,
            legs: [
                { type: optionType, strike: strike1, position: 'long', price: option1Price },
                { type: optionType, strike: strike2, position: 'short', quantity: 2, price: option2Price },
                { type: optionType, strike: strike3, position: 'long', price: option3Price }
            ],
            netCost: netCost,
            maxProfit: maxProfit,
            maxLoss: maxLoss,
            breakEvenLow: breakEvenLow,
            breakEvenHigh: breakEvenHigh,
            payoffCurve: payoffCurve
        };
    }
    
    // 计算跨式策略
    calculateStraddle(underlyingPrice, strike, expirationDays, volatility, riskFreeRate = 0.03) {
        const timeToExpiryYears = expirationDays / 365;
        
        // 买入同等执行价的看涨和看跌期权
        const callPrice = this.optionsCalculator.calculateBlackScholes(
            'call', underlyingPrice, strike, timeToExpiryYears, volatility
        );
        
        const putPrice = this.optionsCalculator.calculateBlackScholes(
            'put', underlyingPrice, strike, timeToExpiryYears, volatility
        );
        
        // 计算净成本
        const netCost = callPrice + putPrice;
        
        // 计算盈亏平衡点
        const breakEvenLow = strike - netCost;
        const breakEvenHigh = strike + netCost;
        
        // 计算收益曲线
        const priceRange = 0.4;
        const priceLow = underlyingPrice * (1 - priceRange);
        const priceHigh = underlyingPrice * (1 + priceRange);
        const steps = 40;
        const priceStep = (priceHigh - priceLow) / steps;
        
        const payoffCurve = [];
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            const callPayoff = Math.max(0, price - strike);
            const putPayoff = Math.max(0, strike - price);
            const payoff = callPayoff + putPayoff - netCost;
            
            payoffCurve.push({
                stockPrice: price,
                payoff: payoff
            });
        }
        
        return {
            strategy: 'straddle',
            legs: [
                { type: 'call', strike: strike, position: 'long', price: callPrice },
                { type: 'put', strike: strike, position: 'long', price: putPrice }
            ],
            netCost: netCost,
            maxLoss: netCost,
            breakEvenLow: breakEvenLow,
            breakEvenHigh: breakEvenHigh,
            payoffCurve: payoffCurve
        };
    }
} 