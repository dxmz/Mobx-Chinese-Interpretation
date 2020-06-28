import {
    IEnhancer,
    IEqualsComparer,
    IObservableArray,
    IObservableDecorator,
    IObservableMapInitialValues,
    IObservableSetInitialValues,
    IObservableObject,
    IObservableValue,
    ObservableMap,
    ObservableSet,
    ObservableValue,
    createDecoratorForEnhancer,
    createDynamicObservableObject,
    createObservableArray,
    deepEnhancer,
    extendObservable,
    fail,
    isES6Map,
    isES6Set,
    isObservable,
    isPlainObject,
    refStructEnhancer,
    referenceEnhancer,
    shallowEnhancer,
    getDefaultDecoratorFromObjectOptions,
    extendObservableObjectWithProperties
} from "../internal"

/**
 * observable.deep: 任何 observable 都使用的默认的调节器。
 * 它将任何(尚未成为 observable )数组，映射或纯对象克隆并转换为 observable 对象，并将其赋值给给定属性
 */
export type CreateObservableOptions = {
    name?: string
    equals?: IEqualsComparer<any>
    deep?: boolean
    defaultDecorator?: IObservableDecorator
    proxy?: boolean
}

// Predefined bags of create observable options, to avoid allocating temporarily option objects
// in the majority of cases
export const defaultCreateObservableOptions: CreateObservableOptions = {
    deep: true,
    name: undefined,
    defaultDecorator: undefined,
    proxy: true
}
Object.freeze(defaultCreateObservableOptions)

function assertValidOption(key: string) {
    if (!/^(deep|name|equals|defaultDecorator|proxy)$/.test(key))
        fail(`invalid option for (extend)observable: ${key}`)
}

export function asCreateObservableOptions(thing: any): CreateObservableOptions {
    if (thing === null || thing === undefined) return defaultCreateObservableOptions
    if (typeof thing === "string") return { name: thing, deep: true, proxy: true }
    if (process.env.NODE_ENV !== "production") {
        if (typeof thing !== "object") return fail("expected options object")
        Object.keys(thing).forEach(assertValidOption)
    }
    return thing as CreateObservableOptions
}


/**
 *enhancer 其实就是一个劫持器，里面提供了劫持各种类型的方法（因为调用了observable的方法实现）
 *  
 * function deepEnhancer(v, _, name) {
    // it is an observable already, done
    if (isObservable(v)) return v

    // something that can be converted and mutated?
    if (Array.isArray(v)) return observable.array(v, { name })
    if (isPlainObject(v)) return observable.object(v, undefined, { name })
    if (isES6Map(v)) return observable.map(v, { name })
    if (isES6Set(v)) return observable.set(v, { name })

    return v
}
 */
// 返回一个decorator装饰器函数，并将传入的enhancer挂在decorator上
// @deepDecorator a = 1;
// @deepDecorator("deep") b = 2;
export const deepDecorator = createDecoratorForEnhancer(deepEnhancer)
const shallowDecorator = createDecoratorForEnhancer(shallowEnhancer)
export const refDecorator = createDecoratorForEnhancer(referenceEnhancer)
const refStructDecorator = createDecoratorForEnhancer(refStructEnhancer)

function getEnhancerFromOptions(options: CreateObservableOptions): IEnhancer<any> {
    return options.defaultDecorator
        ? options.defaultDecorator.enhancer
        : options.deep === false
        ? referenceEnhancer
        : deepEnhancer
}

/**
 * Turns an object, array or function into a reactive structure.
 * @param v the value which should become observable.
 */
function createObservable(v: any, arg2?: any, arg3?: any) {
    // @observable someProp;
    if (typeof arguments[1] === "string" || typeof arguments[1] === "symbol") {
        return deepDecorator.apply(null, arguments as any)
    }

    // it is an observable already, done
    if (isObservable(v)) return v

    // something that can be converted and mutated?
    const res = isPlainObject(v)
        ? observable.object(v, arg2, arg3)
        : Array.isArray(v)
        ? observable.array(v, arg2)
        : isES6Map(v)
        ? observable.map(v, arg2)
        : isES6Set(v)
        ? observable.set(v, arg2)
        : v

    // this value could be converted to a new observable data structure, return it
    if (res !== v) return res

    // otherwise, just box it
    fail(
        process.env.NODE_ENV !== "production" &&
            `The provided value could not be converted into an observable. If you want just create an observable reference to the object use 'observable.box(value)'`
    )
}

export interface IObservableFactory {
    // observable overloads
    (value: number | string | null | undefined | boolean): never // Nope, not supported, use box
    (target: Object, key: string | symbol, baseDescriptor?: PropertyDescriptor): any // decorator
    <T = any>(value: T[], options?: CreateObservableOptions): IObservableArray<T>
    <T = any>(value: Set<T>, options?: CreateObservableOptions): ObservableSet<T>
    <K = any, V = any>(value: Map<K, V>, options?: CreateObservableOptions): ObservableMap<K, V>
    <T extends Object>(
        value: T,
        decorators?: { [K in keyof T]?: Function },
        options?: CreateObservableOptions
    ): T & IObservableObject
}

export interface IObservableFactories {
    box<T = any>(value?: T, options?: CreateObservableOptions): IObservableValue<T>
    array<T = any>(initialValues?: T[], options?: CreateObservableOptions): IObservableArray<T>
    set<T = any>(
        initialValues?: IObservableSetInitialValues<T>,
        options?: CreateObservableOptions
    ): ObservableSet<T>
    map<K = any, V = any>(
        initialValues?: IObservableMapInitialValues<K, V>,
        options?: CreateObservableOptions
    ): ObservableMap<K, V>
    object<T = any>(
        props: T,
        decorators?: { [K in keyof T]?: Function },
        options?: CreateObservableOptions
    ): T & IObservableObject

    /**
     * 某些情况下，不需要将对象转变成 observable 。 
     * 典型案例就是不可变对象，或者不是由你管理，而是由外部库管理的对象。 
     * 例如 JSX 元素、DOM 元素、像 History、window 这样的原生对象，等等。 
     * 对于这类对象，只需要存储引用而不用把它们转变成 observable.
     * 可以使用 ref 调节器。它会确保创建 observable 属性时，只追踪引用而不会把它的值转变成 observable
     * Decorator that creates an observable that only observes the references, but doesn't try to turn the assigned value into an observable.ts.
     */
    ref: IObservableDecorator
    /**
     * observable.shallow 调节器会应用“单层”可观察性。
     * 如果想创建一个 observable 引用的集合，那你会需要它。 
     * 如果新集合分配给具有此调节器的属性，那么它会转变成 observable，
     * 但它的值将保持原样，不同于 deep 的是它不会递归
     * Decorator that creates an observable converts its value (objects, maps or arrays) into a shallow observable structure
     */
    shallow: IObservableDecorator
    /**
     * 任何 observable 都使用的默认的调节器。它将任何(尚未成为 observable )数组，映射或纯对象克隆并转换为 observable 对象，并将其赋值给给定属性
     */
    deep: IObservableDecorator
    // 就像 ref, 但会忽略结构上等于当前值的新值
    struct: IObservableDecorator
}

/**
 * 调用链路：
 * asCreateObservableOptions(options) --> getEnhancerFromOptions(o) -->
 * --> createDecoratorForEnhancer(deepEnhancer) --> createPropDecorator() 
 * --> asObservableObject(target) --> addObservableProp(propertyName, initialValue, enhancer)
 * 
 */
const observableFactories: IObservableFactories = {
    // 对于基本类型 string, boolean, number 可以用 box 来劫持
    box<T = any>(value?: T, options?: CreateObservableOptions): IObservableValue<T> {
        if (arguments.length > 2) incorrectlyUsedAsDecorator("box")
        const o = asCreateObservableOptions(options)
        //  getEnhancerFromOptions(o) 生成enhancer
        return new ObservableValue(value, getEnhancerFromOptions(o), o.name, true, o.equals)
    },
    array<T = any>(initialValues?: T[], options?: CreateObservableOptions): IObservableArray<T> {
        if (arguments.length > 2) incorrectlyUsedAsDecorator("array")
        const o = asCreateObservableOptions(options)
        return createObservableArray(initialValues, getEnhancerFromOptions(o), o.name) as any
    },
    map<K = any, V = any>(
        initialValues?: IObservableMapInitialValues<K, V>,
        options?: CreateObservableOptions
    ): ObservableMap<K, V> {
        if (arguments.length > 2) incorrectlyUsedAsDecorator("map")
        const o = asCreateObservableOptions(options)
        return new ObservableMap<K, V>(initialValues, getEnhancerFromOptions(o), o.name)
    },
    set<T = any>(
        initialValues?: IObservableSetInitialValues<T>,
        options?: CreateObservableOptions
    ): ObservableSet<T> {
        if (arguments.length > 2) incorrectlyUsedAsDecorator("set")
        const o = asCreateObservableOptions(options)
        return new ObservableSet<T>(initialValues, getEnhancerFromOptions(o), o.name)
    },
    /**
     *  如果把一个普通的 JavaScript 对象传递给 observable 方法，对象的所有属性都将被拷贝至一个克隆对象并将克隆对象转变成可观察的。
     *  (普通对象是指不是使用构造函数创建出来的对象，而是以 Object 作为其原型，或者根本没有原型。) 默认情况下，observable 是递归应用的，所以如果对象的某个值是一个对象或数组，那么该值也将通过 observable 传递。
     * 
     * object 函数接收三个参数，第三个参数为 options 可以定制化劫持方式
     * const person = observable({
     *   name: 'lawler',
     *   get labelText() {
     *       return this.showAge ? `${this.name} (age: ${this.age})` : this.name;
     *   },
     *   setAge(age) {
     *       his.age = age;
     *   }
     *  }, { 
     *       // 此为第二个参数 decorators
     *       // setAge设置为action类型，其他属性默认为 observables / computed
     *       setAge: action 
     *       
     *  } /*, 这里传第三个 options 参数 *\/);
     * 
     * decorators的使用：
     * class Person {
            name = "John"
            age = 42
            showAge = false

            get labelText() {
                return this.showAge ? `${this.name} (age: ${this.age})` : this.name;
            }

            setAge(age) {
                this.age = age;
            }
        }
       // 使用 decorate 时，所有字段都应该指定 (毕竟，类里的非 observable 字段可能会更多)
        decorate(Person, {
            name: observable,
            age: observable,
            showAge: observable,
            labelText: computed,
            setAge: action
        })
     * 
     */
    object<T = any>(
        props: T,
        decorators?: { [K in keyof T]: Function },
        options?: CreateObservableOptions
    ): T & IObservableObject {
        if (typeof arguments[1] === "string") incorrectlyUsedAsDecorator("object")
        const o = asCreateObservableOptions(options)
        if (o.proxy === false) {
            // 采用Object.defineProperty劫持
            return extendObservable({}, props, decorators, o) as any
        } else {
            const defaultDecorator = getDefaultDecoratorFromObjectOptions(o)
            // extendObservable中会将adm赋值给属性$mobx，以供proxy代理时调用
            const base = extendObservable({}, undefined, undefined, o) as any
            const proxy = createDynamicObservableObject(base)
            extendObservableObjectWithProperties(proxy, props, decorators, defaultDecorator)
            return proxy
        }
    },
    ref: refDecorator,
    shallow: shallowDecorator,
    deep: deepDecorator,
    struct: refStructDecorator
} as any

// 注意 observable 和 createObservable 是一个对象并且在相互调用
export const observable: IObservableFactory &
    IObservableFactories & {
        enhancer: IEnhancer<any>
    } = createObservable as any

// 并将 observableFactories 的 keys 遍历，将其属性挂在 observable 下（同时也是挂在 createObservable 下
// weird trick to keep our typings nicely with our funcs, and still extend the observable function
Object.keys(observableFactories).forEach(name => (observable[name] = observableFactories[name]))

function incorrectlyUsedAsDecorator(methodName) {
    fail(
        // process.env.NODE_ENV !== "production" &&
        `Expected one or two arguments to observable.${methodName}. Did you accidentally try to use observable.${methodName} as decorator?`
    )
}
