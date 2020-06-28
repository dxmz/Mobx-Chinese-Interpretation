function c() {
    return function d() {
        console.log('d')
        function de() {
            console.log('inner')
        }
        
        return de();
    }
}

console.log(c().apply(null, ['dd']))