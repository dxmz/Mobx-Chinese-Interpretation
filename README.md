
## 关于源码解读  

首先欢迎大家[**star**](https://github.com/dxmz/Mobx-Chinese-Interpretation) 或者 [**fork**](https://github.com/dxmz/Mobx-Chinese-Interpretation) 我的源码解读系列之`mobx`!

断断续续花了一些时间，才把整个脉络理清楚，并且对于一些细节做了注释讲解，第一次解读一份较为复杂的源码，很多地方参考其他人的描述，因为我觉得描述得比自己清晰。

看源码是前端进阶的必走之路，首先能知晓其中原理，在写业务代码时能驾轻就熟，并且能扩展出更高阶的功能；其次明白原理后能帮助你快速排障以及避免bug的出现；最后解读源码能学习到优秀的编程范式，使自己的编程思维和习惯发生微妙的改变，这种改变才是最重要的。

`mobx`的版本是`5.15.4`，源码中我删除了`v4`版本的老代码，讲解基于`v5`版本。




## 主要概念  

### observable 可观察对象 

在 `mobx` 中，我们需要在一个值或一个对象被改变时，触发相应的动作或响应，这种模式就是典型的观察者模式（或发布订阅模式），那么这里一个值或一个对象就是被观察者，动作或者响应充当观察者。

核心思想也比较容易理解，首先进行对象代理（`proxy` 或 `defineProperty`），这样对象就成了`observable`对象；其次观察者在执行主体逻辑时会访问代理对象属性，这时代理对象主动上报（`reportObserved`）自己到观察者的观察对象队列（`observing`）中，同时也会将观察者放入observable对象的观察者队列（`observers`）中，观察者和被观察者相互存有对方的引用，关系正式确立；最后，当设置代理对象属性时，代理对象触发（`reportChanged`）观察者执行主体逻辑。

可能文字描述起来很难弄清楚 `mobx` 的工作原理，所以接下来用代码以及调用链路详细说明。

阅读源码时，首先要清楚这个库的基本使用方式和接口含义，看起源码来才不会茫茫然不知所措，如果再有一份工作原理的调用链路指南，那就相当于铺好了路，自此走向了巅峰。



#### 1、观察者和被观察者如何建立关系 

这里先说明 `mobx` 中观察者是谁，`mobx`中观察者有`reaction`和`autorun`，`autorun`是特殊的`reaction`，而`reaction`实现自`derivation`，也就是说`derivation`是基础的观察者；而被观察者就是`observable`对象。

**注： 下文中可观察变量和被观察者都简称 ‘observable’ **

**调用链路**

```js
（1）observable收集观察者
reaction = new Reaction() --> reaction.track() --> trackDerivedFunction() --> bindDependencies(derivation) --> addObserver(observable, derivation) --> observable.observers.add(node)  

（2）观察者收集observable
observableValue.get() --> this.reportObserved(observable) --> derivation.newObserving![derivation.unboundDepsCount++] = observable

（3）observable变更时触发derivation执行
observableValue.set() --> this.reportChanged(observable) -->  propagateChanged(this) --> observable.observers.forEach((d) => {d.onBecomeStale()}) --> d.schedule() --> globalState.pendingReactions.push(d) 以及 runReactions() --> reactionScheduler(runReactionsHelper) --> 遍历执行相关联的衍生（derivation.runReaction()） --> this.onInvalidate()即用户定义的逻辑
```



#### 2、核心逻辑讲解 



##### Reaction

Reaction类中最核心的是`track`方法，track方法中开启了一个事务，在事务中调用`trackDerivedFunction()`执行用户定义的逻辑 fn() 以及进行关系绑定。

```js
// 删减后的代码
track(fn: () => void) {
        startBatch()
  
        const result = trackDerivedFunction(this, fn, undefined)
     
        if (this.isDisposed) {
            // disposed during last run. Clean up everything that was bound after the dispose call.
            clearObserving(this)
        }
        
        endBatch()
    }
```



##### derivation

`trackDerivedFunction()`在derivation中定义。

```js
function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context: any) {
    const prevAllowStateReads = allowStateReadsStart(true)
    // pre allocate array allocation + room for variation in deps
    // array will be trimmed by bindDependencies
    // 把 derivation.dependenciesState 和 derivation.observing数组内所有 ob.lowestObserverState 改为    IDerivationState.UP_TO_DATE （0）
    // 先调用 changeDependenciesStateTo0 方法将 derivation 和 observing 置为稳定态 UP_TO_DATE，主要是方便后续判断是否处在收集依赖阶段
    changeDependenciesStateTo0(derivation)
    // 提前为新 observing 申请空间，之后会trim
    derivation.newObserving = new Array(derivation.observing.length + 100)
    // unboundDepsCount记录尚未绑定的数量，observable被观察者观察时通过reportObserved()更新值
    derivation.unboundDepsCount = 0
    derivation.runId = ++globalState.runId
    // 保存Reaction上下文，将当前进行的reaction赋值给globalState.trackingDerivation供bindDependencies依赖收集用
    const prevTracking = globalState.trackingDerivation
    globalState.trackingDerivation = derivation
    let result
    if (globalState.disableErrorBoundaries === true) {
        result = f.call(context)
    } else {
        try {
            // 这一步将会触发 observable 的访问(因为f中会访问可观察对象的属性)，
            // 即我们 ob.name --> $mobx.name.get() (ObservableValue.prototype.get)
            // -->reportObserved(ObservableValue)
            
            //调用track参数中的函数,在mobx-react里就是组件的render方法
            result = f.call(context)
        } catch (e) {
            result = new CaughtException(e)
        }
    }
    //恢复Reaction上下文
    globalState.trackingDerivation = prevTracking
    //Reaction跟Observable建立关系
    bindDependencies(derivation)

    warnAboutDerivationWithoutDependencies(derivation)

    allowStateReadsEnd(prevAllowStateReads)

    return result
}
```

其中`result = f.call(context)`会触发`observable.get()`，上面的调用链路中可以看到`observable.observers.add(node)`这一步将reaction观察者放入observable的观察者对列中。

接下来是Reaction跟Observable建立关系`bindDependencies(derivation)`。

```js
function bindDependencies(derivation: IDerivation) {
    // invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");
    // 暂存旧的observable列表
    const prevObserving = derivation.observing
    // 用新的observable列表替换旧的列表
    const observing = (derivation.observing = derivation.newObserving!)
    let lowestNewObservingDerivationState = IDerivationState.UP_TO_DATE

    // Go through all new observables and check diffValue: (this list can contain duplicates):
    //   0: first occurrence, change to 1 and keep it
    //   1: extra occurrence, drop it
    // 遍历所有新的observable，去除重复的observable
    let i0 = 0,
        l = derivation.unboundDepsCount
    for (let i = 0; i < l; i++) {
        // 这里实际上用了双指针方法去重，i0为慢指针，i为快指针
        const dep = observing[i]
        // 跳过重复的值，即diffValue 等于 1的值；当跳过重复的值时i与i0就不相等了，i领先于i0
        if (dep.diffValue === 0) {
            dep.diffValue = 1
            if (i0 !== i) observing[i0] = dep
            i0++
        }

        // Upcast is 'safe' here, because if dep is IObservable, `dependenciesState` will be undefined,
        // not hitting the condition
        if (((dep as any) as IDerivation).dependenciesState > lowestNewObservingDerivationState) {
            lowestNewObservingDerivationState = ((dep as any) as IDerivation).dependenciesState
        }
    }
    observing.length = i0

    derivation.newObserving = null // newObserving shouldn't be needed outside tracking (statement moved down to work around FF bug, see #614)

    // Go through all old observables and check diffValue: (it is unique after last bindDependencies)
    //   0: it's not in new observables, unobserve it
    //   1: it keeps being observed, don't want to notify it. change to 0
    // 遍历旧observable列表：
    // diffValue为0表示不在新的observable列表中（每一轮新的observables的diffValue都会被设置为1），在derivation中解除观察；
    // diffValue为1表示该值仍在被观察（每一轮的依赖更新时，假如一个可观察对象dep在之前一轮也在依赖列表中，
    // 此时dep对象是同一个，新的一轮更新newObserving依赖时，diffValue会被更新为1）；
    // 和newObserving去重操作一样巧妙，diffValue的作用很大呀
    l = prevObserving.length
    while (l--) {
        const dep = prevObserving[l]
        if (dep.diffValue === 0) {
            removeObserver(dep, derivation)
        }
        // 新旧遍历之后依旧将diffValue置0，即上面的 first occurrence
        dep.diffValue = 0
    }

    // Go through all new observables and check diffValue: (now it should be unique)
    //   0: it was set to 0 in last loop. don't need to do anything.
    //   1: it wasn't observed, let's observe it. set back to 0
    // 这里需要做这一步操作是因为第一步newObserving过滤后是新增的观察对象，
    // 第二步prevObserving将依赖的diffValue置0，但prevObserving中的依赖已经是addObserver()过的，
    // 所以就需要标记一下（diffValue置0），最后newObserving中的依赖diffValue为1的就进行addObserver()
    while (i0--) {
        const dep = observing[i0]
        if (dep.diffValue === 1) {
            dep.diffValue = 0
            // 给 observableValue 注册 observer
            // value change 时 observable(object, array, set...) 调用 this.atom.reportChanged() 发送通知
            // foreach 通知每个 reaction 调用 onBecomeStale，也就是 schedule 方法

            // 调用链路：value change --> observable设置值set(newVal) --> this.atom.reportChanged() 
            // --> propagateChanged(this) --> observable.observers.forEach调用observer.onBecomeStale() 
            // --> reaction.schedule() --> globalState.pendingReactions.push(this)以及runReactions() 
            // --> reactionScheduler() 
            // --> allReactions.forEach()执行每个reaction的reaction.runReaction() 
            // --> 执行每个reaction的this.onInvalidate()
            addObserver(dep, derivation)
        }
    }
    // NOTE: 收集完的依赖保存到 reaction.observing 中，在 getDependencyTree api 中会调用到

    // 对于新添加的观察数据，将 derivation 添加 globalState.pendingReactions 中，
    // 在当前事务周期中处理
    // Some new observed derivations may become stale during this derivation computation
    // so they have had no chance to propagate staleness (#916)
    if (lowestNewObservingDerivationState !== IDerivationState.UP_TO_DATE) {
        derivation.dependenciesState = lowestNewObservingDerivationState
        derivation.onBecomeStale()
    }
}
```



了解了衍生后，还有一个重要的知识点是`状态`，状态代表了衍生和可观察对象的不同阶段，通过状态可以更好地控制逻辑的执行。衍生或可观察对象有四个状态，值越高表示越不稳定：

`NOT_TRACKING`：初始时或衍生不再订阅可观察对象时的状态

`UP_TO_DATE`：表示当前的值是最新的或者衍生的依赖未发生变化，不需要重新计算

`POSSIBLY_STALE`：计算值的依赖发生变化时的状态，表示计算值可能有变更；比如计算值`a`依赖了`observable b` 和`observable c`，如果这时`b`和`c`都发生了变化，但最终的结果`a`未发生变化，那就不需要通知`a`的观察者`observers`执行逻辑了

`STALE`：表示衍生的逻辑需要重新执行，这时衍生依赖的对象发生了变更

```js
enum IDerivationState {
    NOT_TRACKING = -1,
    UP_TO_DATE = 0,
    POSSIBLY_STALE = 1,
    STALE = 2
}
```



##### observable

对象经过 `mobx` 处理后变成可观察对象，这里的处理是指通过 `proxy `或者 `defineProperty` 代理。在`mobx`中一个基础类型的值可以成为`observable`，一个`array` /` map` / `set` / `object`也可以成为`observable`，但他们的处理方式有一些差别，具体看下文分析。

我们用装饰器方式作用变量时：

```js
import { observable } from "mobx"

class Todo {

  id = Math.random()

  @observable title = ""

  @observable finished = false

}
```

`observable`实际调用了`createObservable`函数，而`createObservable`中又调用了`observable`的方法。

`observable`有什么方法呢，先看它的类型。

```js
const observable: IObservableFactory & IObservableFactories & { enhancer: IEnhancer<any>}
```

其中`IObservableFactories`是个接口，`observableFactories`是它的具体实现，对基本数据类型以及对象进行代理和劫持。

```js
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
```

那既然`observableFactories`定义了数据类型的劫持方法，那怎么让observable也有同样的功能，接下来看：

```js
Object.keys(observableFactories).forEach(name => (observable[name] = observableFactories[name]))
```

明白了吧。

回到刚才所说的`observable`实际调用了`createObservable`函数：

里面对传入的值或对象进行分类别劫持。

```js
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
}
```



###### object的劫持

object 函数接收三个参数，第三个参数为 options 可以定制化劫持方式。

使用示例：

```js
const person = observable({
    name: 'lawler',
    get labelText() {
        return this.showAge ? `${this.name} (age: ${this.age})` : this.name;
    },
    setAge(age) {
        his.age = age;
    }
}, { 
    // 此为第二个参数 decorators
    // setAge设置为action类型，其他属性默认为 observables / computed
    setAge: action 

} /*, 这里传第三个 options 参数 *\/);
```

来看看它是怎么实现的：

```js
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
    
```

第一步：生成配置选项

如果`options`传入的是个字符串，那么

```js
const o = { name: thing, deep: true, proxy: true }
```

如果不传任何配置项，则返回默认配置项，所以默认是用proxy代理劫持

```js
const defaultCreateObservableOptions = {
    deep: true,
    name: undefined,
    defaultDecorator: undefined,
    proxy: true
}
```

第二步： 生成默认装饰器

```js
const defaultDecorator = getDefaultDecoratorFromObjectOptions(o) 默认项返回 deepDecorator
```
默认的 `deepDecorator`代码部分：

```js
const deepDecorator = createDecoratorForEnhancer(deepEnhancer)

// 删除了一些开发环境的代码
function createDecoratorForEnhancer(enhancer: IEnhancer<any>): IObservableDecorator {
    invariant(enhancer)
    const decorator = createPropDecorator(
        true,
        (
            target: any,
            propertyName: PropertyKey,
            descriptor: BabelDescriptor | undefined,
            _decoratorTarget,
            decoratorArgs: any[]
        ) => {
            const initialValue = descriptor
                ? descriptor.initializer
                    ? descriptor.initializer.call(target)
                    : descriptor.value
                : undefined
            /**
             * asObservableObject，其传入参数为原始对象，
             * 返回值是ObservableObjectAdministration类型对象adm
             * 同时将adm绑定到$mobx属性上，共对象使用
             * 
             * 并且链式调用了 addObservableProp，
             * 通过 enhancer，把 propertyName 属性赋上劫持后的 initialValue
             */
            asObservableObject(target).addObservableProp(propertyName, initialValue, enhancer)
        }
    )
   
    const res: any = decorator
    res.enhancer = enhancer
    return res
}
```

重点在`asObservableObject(target).addObservableProp(propertyName, initialValue, enhancer)`中。

首先是``asObservableObject`：

这个方法的作用是生成一个`adm`对象并返回，同时将`adm`赋值到对象的`$mobx`属性中，供对象使用。

```js
export function asObservableObject(
    target: any,
    name: PropertyKey = "",
    defaultEnhancer: IEnhancer<any> = deepEnhancer
): ObservableObjectAdministration {
    if (Object.prototype.hasOwnProperty.call(target, $mobx)) return target[$mobx]

    if (!isPlainObject(target))
        name = (target.constructor.name || "ObservableObject") + "@" + getNextId()
    if (!name) name = "ObservableObject@" + getNextId()

    const adm = new ObservableObjectAdministration(
        target,
        new Map(),
        stringifyKey(name),
        defaultEnhancer
    )
    addHiddenProp(target, $mobx, adm)
    return adm
}
```

而`ObservableObjectAdministration`封装了一些read、write、has等方法

```js
/**
 * 可以看出 adm 其实也是个封装类，具体围绕 values 展开，
 * 而 values 是个 Map，键为 PropertyKey，值为 ObservableValue像 read，write 等方法，
 * 最后都是调用的 ObservableValue 提供的 api
 */
class ObservableObjectAdministration
    constructor(
        public target: any,
        public values = new Map<PropertyKey, ObservableValue<any> | ComputedValue<any>>(),
        public name: string,
        public defaultEnhancer: IEnhancer<any>
    ) {
        this.keysAtom = new Atom(name + ".keys")
    }

    read(key: PropertyKey) {
        return this.values.get(key)!.get()
    }

    write(key: PropertyKey, newValue) {
        // 省略
    }

    has(key: PropertyKey) {
        // 省略
    }

    addObservableProp(
        propName: PropertyKey,
        newValue,
        enhancer: IEnhancer<any> = this.defaultEnhancer
    ) {
        // 省略
    }

    addComputedProp(
        propertyOwner: any, // where is the property declared?
        propName: PropertyKey,
        options: IComputedValueOptions<any>
    ) {
       // 省略
    }

    remove(key: PropertyKey) {
        // 省略
    }

    observe(callback: (changes: IObjectDidChange) => void, fireImmediately?: boolean): Lambda {
        return registerListener(this, callback)
    }
}
```

接下来调用`adm.addObservableProp(propertyName, initialValue, enhancer)`：

为observable对象添加属性并劫持set / get操作；同时也将 initialValue 变成 ObservableValue，最后以属性名为键值存入adm.values对象中（实际的proxy代理时会用到，看下文）。

```js
 addObservableProp(
        propName: PropertyKey,
        newValue,
        enhancer: IEnhancer<any> = this.defaultEnhancer
    ) {
        // this为adm
        const { target } = this
        assertPropertyConfigurable(target, propName)

        const observable = new ObservableValue(
            newValue,
            enhancer,
            `${this.name}.${stringifyKey(propName)}`,
            false
        )
        
        this.values.set(propName, observable)
        newValue = (observable as any).value // observableValue might have changed it

        Object.defineProperty(target, propName, generateObservablePropConfig(propName))
        this.notifyPropertyAddition(propName, newValue)
    }
```



第三步：base对象为一个空对象，但属性`$mobx`值为`adm`对象

```js
const base = extendObservable({}, undefined, undefined, o) as any
```

```js
function extendObservable<A extends Object, B extends Object>(
    target: A,
    properties?: B,
    decorators?: { [K in keyof B]?: Function },
    options?: CreateObservableOptions
): A & B {
    options = asCreateObservableOptions(options)
    const defaultDecorator = getDefaultDecoratorFromObjectOptions(options)
    //  这里target是空对象‘{}’
    initializeInstance(target) 
    // target的属性$mobx值为adm对象
    asObservableObject(target, options.name, defaultDecorator.enhancer) // make sure object is observable, even without initial props
    if (properties)
        extendObservableObjectWithProperties(target, properties, decorators, defaultDecorator)
    return target as any
}
```



第四步： 代理对象

```js
const proxy = createDynamicObservableObject(base)
```
```js
function createDynamicObservableObject(base) {
    // objectProxyTraps中定义了代理的属性(has/get/set等)，其实还是调用了adm对象的方法
    const proxy = new Proxy(base, objectProxyTraps)
    base[$mobx].proxy = proxy
    return proxy
}
```

在`objectProxyTraps`的get方法中，会从`adm.values.get(name)`取出`observable`使用。

```js
 get(target: IIsObservableObject, name: PropertyKey) {
        if (name === $mobx || name === "constructor" || name === mobxDidRunLazyInitializersSymbol)
            return target[name]
        const adm = getAdm(target)
        const observable = adm.values.get(name)
        if (observable instanceof Atom) {
            const result = (observable as any).get()
            if (result === undefined) {
                // This fixes #1796, because deleting a prop that has an
                // undefined value won't retrigger a observer (no visible effect),
                // the autorun wouldn't subscribe to future key changes (see also next comment)
                adm.has(name as any)
            }
            return result
        }
        // make sure we start listening to future keys
        // note that we only do this here for optimization
        if (isPropertyKey(name)) adm.has(name)
        return target[name]
    }
```



第五步：对属性进行处理，用各自的装饰器包裹

```js
extendObservableObjectWithProperties(proxy, props, decorators, defaultDecorator)
```

这段代码的作用就是将对象的各种属性经过相应的装饰器包裹以后再赋值给对象的代理proxy的属性。

```js
function extendObservableObjectWithProperties(
    target,
    properties,
    decorators,
    defaultDecorator
) {
    startBatch()
    try {
        const keys = getPlainObjectKeys(properties)
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(properties, key)!
            
            const decorator =
                decorators && key in decorators
                    ? decorators[key]
                    : descriptor.get
                    ? computedDecorator
                    : defaultDecorator

            const resultDescriptor = decorator!(target, key, descriptor, true)
            if (
                resultDescriptor // otherwise, assume already applied, due to `applyToInstance`
            )
                Object.defineProperty(target, key, resultDescriptor)
        }
    } finally {
        endBatch()
    }
}

```

其中当`decorator`是用户定义的装饰器类别，这里有计算值装饰器`computedDecorator`, action类别的装饰器以及默认的`defaultDecorator`observable装饰器。

这里只讲一下action装饰器，其他的也比较容易理解。

在上面的使用示例中`setAge: action `,`decorator`就是`action`。

上代码：

```js
const action: IActionFactory = function action(arg1, arg2?, arg3?, arg4?): any {
    // action(fn() {})
    if (arguments.length === 1 && typeof arg1 === "function")
        return createAction(arg1.name || "<unnamed action>", arg1)
    // action("name", fn() {})
    if (arguments.length === 2 && typeof arg2 === "function") return createAction(arg1, arg2)

    // @action("name") fn() {}
    if (arguments.length === 1 && typeof arg1 === "string") return namedActionDecorator(arg1)

    // @action fn() {}
    if (arg4 === true) {
        // apply to instance immediately
        addHiddenProp(arg1, arg2, createAction(arg1.name || arg2, arg3.value, this))
    } else {
        return namedActionDecorator(arg2).apply(null, arguments as any)
    }
} as any
```

这里我们传入了四个参数，且`arg4 === true`，进入`addHiddenProp`，作用是`增加对象的不可遍历属性`

```js
function addHiddenProp(object: any, propName: PropertyKey, value: any) {
    Object.defineProperty(object, propName, {
        enumerable: false,
        writable: true,
        configurable: true,
        value
    })
}
```

接着我们看看`createAction`做了什么：

`createAction`返回一个函数， 而这个函数的返回值是执行`descriptor`的结果，即是上面示例中`setAge()`的执行结果。

```js
function createAction(actionName: string, fn: Function, ref?: Object): Function & IAction {
    const res = function() {
        // 首先将runInfo等信息保存起来，然后执行 fn ，最后恢复刚才保存的信息并且会调用endBatch()
        return executeAction(actionName, fn, ref || this, arguments)
    }
    ;(res as any).isMobxAction = true
   
    return res as any
}

function executeAction(actionName: string, fn: Function, scope?: any, args?: IArguments) {
    // 将derivation等信息保存起来，在_endAction()中恢复
    const runInfo = _startAction(actionName, scope, args)
    try {
        return fn.apply(scope, args)
    } catch (err) {
        runInfo.error = err
        throw err
    } finally {
        _endAction(runInfo)
    }
}
```

好了，现在回过头看看 mobx 文档中定义的`action`:

> 它接收一个函数并返回具有同样签名的函数，但是用 `transaction`、`untracked` 和 `allowStateChanges` 包裹起来，尤其是 `transaction` 的自动应用会产生巨大的性能收益， 动作会分批处理变化并只在(最外层的)动作完成后通知计算值和反应。 这将确保在动作完成之前，在动作期间生成的中间值或未完成的值对应用的其余部分是不可见的。

这里的`transaction`是指`_startAction`和`_endAction`中开启的事务`startBatch()`和`endBatch()`，在事务处理期间`globalState.trackingDerivation = null`，意味着action处理期间不进行依赖收集（即描述中的`untracked` ，因为执行action可能访问observable的属性，触发get代理，上文中说到get代理会进行依赖收集，但action是不需要进行依赖收集的，它仅仅是执行一个动作）；在`endBatch()`中接着执行`runReactions()`（即描述中所说的`动作完成后通知计算值和反应`）； `allowStateChanges` 就比较好理解了，是控制observable对象是否只能在action中变更值，细节可以在文件`configure.ts`中查看。

那么`addHiddenProp(arg1, arg2, createAction(arg1.name || arg2, arg3.value, this))`就是把action类别的动作用装饰器action包裹起来再丢给proxy对象。

所以，observable.object(对象，装饰器， 配置项)最终会产生一个新的对象，这个新的对象是个代理对象。



###### array的劫持 

看完了复杂额度object的代理，那么很多概念都已经有了了解，其他类型的对象就容易很多。

代理array调用了`createObservableArray`函数。

```js
function createObservableArray<T>(
    initialValues: any[] | undefined,
    enhancer: IEnhancer<T>,
    name = "ObservableArray@" + getNextId(),
    owned = false
): IObservableArray<T> {
    const adm = new ObservableArrayAdministration(name, enhancer, owned)
    addHiddenFinalProp(adm.values, $mobx, adm)
    const proxy = new Proxy(adm.values, arrayTraps) as any
    adm.proxy = proxy
    if (initialValues && initialValues.length) {
        const prev = allowStateChangesStart(true)
        // 初始化
        adm.spliceWithArray(0, 0, initialValues)
        allowStateChangesEnd(prev)
    }
    return proxy
}
```

第一步：创建`adm`对象，后面的操作都是调用 adm 中的方法；

这里面最重要的方法是`spliceWithArray`，相当于拦截了数组的`splice`操作，对新加入的元素进行`enhancer `劫持，删除的元素`dehancer`处理，最后通知数组发生了变更`reportChanged()`。

```js
class ObservableArrayAdministration
    implements IInterceptable<IArrayWillChange<any> | IArrayWillSplice<any>>, IListenable {
    atom: IAtom
    values: any[] = []
    interceptors
    changeListeners
    enhancer: (newV: any, oldV: any | undefined) => any
    dehancer: any
    proxy: any[] = undefined as any
    lastKnownLength = 0

    constructor(name, enhancer: IEnhancer<any>, public owned: boolean) {
        this.atom = new Atom(name || "ObservableArray@" + getNextId())
        this.enhancer = (newV, oldV) => enhancer(newV, oldV, name + "[..]")
    }

    getArrayLength(): number {
        this.atom.reportObserved()
        return this.values.length
    }

    setArrayLength(newLength: number) {
        if (typeof newLength !== "number" || newLength < 0)
            throw new Error("[mobx.array] Out of range: " + newLength)
        let currentLength = this.values.length
        if (newLength === currentLength) return
        else if (newLength > currentLength) {
            const newItems = new Array(newLength - currentLength)
            for (let i = 0; i < newLength - currentLength; i++) newItems[i] = undefined // No Array.fill everywhere...
            this.spliceWithArray(currentLength, 0, newItems)
        } else this.spliceWithArray(newLength, currentLength - newLength)
    }

    updateArrayLength(oldLength: number, delta: number) {
        if (oldLength !== this.lastKnownLength)
            throw new Error(
                "[mobx] Modification exception: the internal structure of an observable array was changed."
            )
        this.lastKnownLength += delta
    }

    spliceWithArray(index: number, deleteCount?: number, newItems?: any[]): any[] {
        checkIfStateModificationsAreAllowed(this.atom)
        const length = this.values.length

        if (index === undefined) index = 0
        else if (index > length) index = length
        // inedx小于0则从list尾部取值
        else if (index < 0) index = Math.max(0, length + index)

        if (arguments.length === 1) deleteCount = length - index
        else if (deleteCount === undefined || deleteCount === null) deleteCount = 0
        // Math.min(deleteCount, length - index) 防止删除的数量超过数组长度
        else deleteCount = Math.max(0, Math.min(deleteCount, length - index))

        if (newItems === undefined) newItems = EMPTY_ARRAY

        if (hasInterceptors(this)) {
            const change = interceptChange<IArrayWillSplice<any>>(this as any, {
                object: this.proxy as any,
                type: "splice",
                index,
                removedCount: deleteCount,
                added: newItems
            })
            if (!change) return EMPTY_ARRAY
            deleteCount = change.removedCount
            newItems = change.added
        }

        // 对新值用 enhancer 进行劫持
        newItems = newItems.length === 0 ? newItems : newItems.map(v => this.enhancer(v, undefined))
        
        // 将劫持后的 array 更新到 this.values 中
        // res 为删除后的元素数组
        const res = this.spliceItemsIntoValues(index, deleteCount, newItems)

        if (deleteCount !== 0 || newItems.length !== 0) this.notifyArraySplice(index, newItems, res)
        // 对删除后的元素进行 dehancer 处理
        return this.dehanceValues(res)
    }

    spliceItemsIntoValues(index, deleteCount, newItems: any[]): any[] {
        if (newItems.length < MAX_SPLICE_SIZE) {
            // splice返回删除的元素
            return this.values.splice(index, deleteCount, ...newItems)
        } else {
            // res为删除的元素
            const res = this.values.slice(index, index + deleteCount)
            this.values = this.values
                .slice(0, index)
                .concat(newItems, this.values.slice(index + deleteCount))
            return res
        }
    }

    notifyArrayChildUpdate(index: number, newValue: any, oldValue: any) {
        // 省略...
        this.atom.reportChanged()
    }

    notifyArraySplice(index: number, added: any[], removed: any[]) {
        // 省略...
        this.atom.reportChanged()
    }
}
```

第二步：将adm丢给`adm.values`的属性`$mobx`；

```js
addHiddenFinalProp(adm.values, $mobx, adm)
```

第三步：代理对象

```js
const proxy = new Proxy(adm.values, arrayTraps)
```

其中代理的get、set方法在`arrayTraps`中，

```js
const arrayTraps = {
    get(target, name) {
        if (name === $mobx) return target[$mobx]
        if (name === "length") return target[$mobx].getArrayLength()
        if (typeof name === "number") {
            return arrayExtensions.get.call(target, name)
        }
        if (typeof name === "string" && !isNaN(name as any)) {
            return arrayExtensions.get.call(target, parseInt(name))
        }
        if (arrayExtensions.hasOwnProperty(name)) {
            return arrayExtensions[name]
        }
        return target[name]
    },
    set(target, name, value): boolean {
        if (name === "length") {
            target[$mobx].setArrayLength(value)
        }
        if (typeof name === "number") {
            arrayExtensions.set.call(target, name, value)
        }
        if (typeof name === "symbol" || isNaN(name)) {
            target[name] = value
        } else {
            // numeric string
            arrayExtensions.set.call(target, parseInt(name), value)
        }
        return true
    },
    preventExtensions(target) {
        fail(`Observable arrays cannot be frozen`)
        return false
    }
}
```

可以看到除了一如既往地调用`adm`的方法外，还用到了`arrayExtensions`，它封装了数组的基本操作，本质和是哪个还是调用了`adm`的方法。

```js
// 全部调用对象上的属性$mobx值---adm来对values操作
const arrayExtensions = {
        intercept(handler: IInterceptor<IArrayWillChange<any> | IArrayWillSplice<any>>): Lambda {
            return this[$mobx].intercept(handler)
        },
        observe(
            listener: (changeData: IArrayChange<any> | IArraySplice<any>) => void,
            fireImmediately = false
        ): Lambda {
            const adm: ObservableArrayAdministration = this[$mobx]
            return adm.observe(listener, fireImmediately)
        },
        clear(): any[] {
            return this.splice(0)
        },
        replace(newItems: any[]) {
            const adm: ObservableArrayAdministration = this[$mobx]
            return adm.spliceWithArray(0, adm.values.length, newItems)
        },
        toJS(): any[] {
            return (this as any).slice()
        },
        toJSON(): any[] {
            // Used by JSON.stringify
            return this.toJS()
        },

        splice(index: number, deleteCount?: number, ...newItems: any[]): any[] {
            const adm: ObservableArrayAdministration = this[$mobx]
            switch (arguments.length) {
                case 0:
                    return []
                case 1:
                    return adm.spliceWithArray(index)
                case 2:
                    return adm.spliceWithArray(index, deleteCount)
            }
            return adm.spliceWithArray(index, deleteCount, newItems)
        },

        spliceWithArray(index: number, deleteCount?: number, newItems?: any[]): any[] {
            const adm: ObservableArrayAdministration = this[$mobx]
            return adm.spliceWithArray(index, deleteCount, newItems)
        },

        push(...items: any[]): number {
            const adm: ObservableArrayAdministration = this[$mobx]
            adm.spliceWithArray(adm.values.length, 0, items)
            return adm.values.length
        },

        pop() {
            return this.splice(Math.max(this[$mobx].values.length - 1, 0), 1)[0]
        },

        shift() {
            return this.splice(0, 1)[0]
        },

        unshift(...items: any[]): number {
            const adm = this[$mobx]
            adm.spliceWithArray(0, 0, items)
            return adm.values.length
        },

        reverse(): any[] {
            const clone = (<any>this).slice()
            return clone.reverse.apply(clone, arguments)
        },

        sort(compareFn?: (a: any, b: any) => number): any[] {
            const clone = (<any>this).slice()
            return clone.sort.apply(clone, arguments)
        },

        remove(value: any): boolean {
            const adm: ObservableArrayAdministration = this[$mobx]
            const idx = adm.dehanceValues(adm.values).indexOf(value)
            if (idx > -1) {
                this.splice(idx, 1)
                return true
            }
            return false
        },

        get(index: number): any | undefined {
            const adm: ObservableArrayAdministration = this[$mobx]
            if (adm) {
                if (index < adm.values.length) {
                    adm.atom.reportObserved()
                    return adm.dehanceValue(adm.values[index])
                }
            }
            return undefined
        },

        set(index: number, newValue: any) {
            const adm: ObservableArrayAdministration = this[$mobx]
            const values = adm.values
            if (index < values.length) {
                // update at index in range
                checkIfStateModificationsAreAllowed(adm.atom)
                const oldValue = values[index]
                if (hasInterceptors(adm)) {
                    const change = interceptChange<IArrayWillChange<any>>(adm as any, {
                        type: "update",
                        object: adm.proxy as any, // since "this" is the real array we need to pass its proxy
                        index,
                        newValue
                    })
                    if (!change) return
                    newValue = change.newValue
                }
                newValue = adm.enhancer(newValue, oldValue)
                const changed = newValue !== oldValue
                if (changed) {
                    values[index] = newValue
                    adm.notifyArrayChildUpdate(index, newValue, oldValue)
                }
            } else if (index === values.length) {
                // add a new item
                adm.spliceWithArray(index, 0, [newValue])
            } else {
                // out of bounds
                throw new Error(
                    `[mobx.array] Index out of bounds, ${index} is larger than ${values.length}`
                )
            }
        }
    }
```

数组还有一些内置的方法， mobx 做了进一步处理，都放到`arrayExtensions`中。

```js
;[
    "concat",
    "every",
    "filter",
    "forEach",
    "indexOf",
    "join",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "toString",
    "toLocaleString"
].forEach(funcName => {
    arrayExtensions[funcName] = function() {
        const adm: ObservableArrayAdministration = this[$mobx]
        // atom 中有reportObserved和reportChanged函数
        adm.atom.reportObserved()
        const res = adm.dehanceValues(adm.values)
        return res[funcName].apply(res, arguments)
    }
})
```

数组对象被代理后拥有了依赖收集，变更通知的功能，就可以和derivation一起工作了。



###### map的劫持 

`ObservableMap`的代码冗长，一步步拆解分析。

先来看看它的构造函数：

`this._data`是`initialData`的代理对象。

`this._hasMap`是缓存map中keys的变化--新增还是删除状态。

```js
 constructor(
        initialData?: IObservableMapInitialValues<K, V>,
        public enhancer: IEnhancer<V> = deepEnhancer,
        public name = "ObservableMap@" + getNextId()
    ) {
        this._data = new Map()
        // this.get()中会调用this.has()
        // this.has()中会调用this._hasMap.set()设置值
        // 所以只有当observerableMap.get('xxx')时，_hasMap中才会存有‘xxx’属性和值
        // 当在map中新增属性或者删除属性时会调用_updateHasMapEntry()，
        // _updateHasMapEntry()的作用是设置新增属性'xxx'时其value值为'true', 删除'xxx'时其value值为'false'
        // 例如autorun(() => console.log(counterStore.testMap.get('xxx')));
        // 这时，_hasMap中存有值了；

        // 但如果在store中@action func() {this.testMap.get('xxx')}，
        // 这样是不会把‘xxx’放入_hasMap中的

        // 总结：_hasMap用来存储新增或删除的keys（仅在autorun这类型的reaction中才生效）
        // 因而_hasMap是缓存map中keys的变化--新增还是删除状态
        this._hasMap = new Map()
        // 将初始数据的属性和值赋值给this._data
        // merge时会调用this.set()-->this._addValue()，使得_data属性变成ObservableValue
        this.merge(initialData)
    }
```

关键看`thie.merge(initialData)`， 就是把`initialData`遍历赋值给`this._data`，如果是新增属性，先把值变成`observable`对象，接着通知变更`reportChanged()`，触发derivation；如果是update值，将新值用`enhancer`处理后通知变更`this.reportChanged()`。

```js
// 将other对象的属性依次赋值给this对象，并返回this
merge(other: ObservableMap<K, V> | IKeyValueMap<V> | any): ObservableMap<K, V> {
    if (isObservableMap(other)) {
    	other = other.toJS()
	}
    // transaction开启一个事务，在事务执行期间视图view不会更新，是一个同步执行的过程
    transaction(() => {
        if (isPlainObject(other))
            getPlainObjectKeys(other).forEach(key => this.set((key as any) as K, other[key]))
        else if (Array.isArray(other)) other.forEach(([key, value]) => this.set(key, value))
        else if (isES6Map(other)) {
            if (other.constructor !== Map)
                fail("Cannot initialize from classes that inherit from Map: " + other.constructor.name)
            other.forEach((value, key) => this.set(key, value))
        } else if (other !== null && other !== undefined)
            fail("Cannot initialize map from " + other)
    })
    return this
}

set(key: K, value: V) {
    const hasKey = this._has(key)

    if (hasKey) {
        this._updateValue(key, value)
    } else {
        this._addValue(key, value)
    }
    return this
}
```

```js
private _updateValue(key: K, newValue: V | undefined) {
    const observable = this._data.get(key)!
          newValue = (observable as any).prepareNewValue(newValue) as V
          if (newValue !== globalState.UNCHANGED) {
              observable.setNewValue(newValue as V)
          }
}

private _addValue(key: K, newValue: V) {
    checkIfStateModificationsAreAllowed(this._keysAtom)
    transaction(() => {
        const observable = new ObservableValue(
            newValue,
            this.enhancer,
            `${this.name}.${stringifyKey(key)}`,
            false
        )
        this._data.set(key, observable)
        newValue = (observable as any).value // value might have been changed
        this._updateHasMapEntry(key, true)
        this._keysAtom.reportChanged()
    })
}
```

`ObservableMap`中还定义了`replace`、`clear`以及`entries`等map方法，相当于劫持了原生map的方法。



###### set的劫持

照例，先看它的构造函数做了什么：

```js
constructor(
        initialData?: IObservableSetInitialValues<T>,
        enhancer: IEnhancer<T> = deepEnhancer,
        public name = "ObservableSet@" + getNextId()
    ) {
        if (typeof Set !== "function") {
            throw new Error(
                "mobx.set requires Set polyfill for the current browser. Check babel-polyfill or core-js/es6/set.js"
            )
        }

        this.enhancer = (newV, oldV) => enhancer(newV, oldV, name)

        if (initialData) {
            this.replace(initialData)
        }
    }
```

重新定义了`enhancer`函数，以及处理`initialData`。

```js
 replace(other: ObservableSet<T> | IObservableSetInitialValues<T>): ObservableSet<T> {
        if (isObservableSet(other)) {
            other = other.toJS()
        }

        transaction(() => {
            if (Array.isArray(other)) {
                this.clear()
                other.forEach(value => this.add(value))
            } else if (isES6Set(other)) {
                this.clear()
                other.forEach(value => this.add(value))
            } else if (other !== null && other !== undefined) {
                fail("Cannot initialize set from " + other)
            }
        })

        return this
    }
```

`replace`很简单，做了一些判断，最后调用`add`函数：

又看到熟悉的`this._data`，和`ObservableMap`中的作用一样。

`add`函数也简单，`enhancer`处理后放入`this._data`中，最后上报变更。

```js
add(value: T) {
    checkIfStateModificationsAreAllowed(this._atom)
    if (!this.has(value)) {
        transaction(() => {
            this._data.add(this.enhancer(value, undefined))
            this._atom.reportChanged()
        })
    }

    return this
}
```



###### 基本数据类型的劫持 

string，boolean， number 用 box 劫持，最终是调用` ObservableValue()`。

用`enhancer`处理后覆盖原来的值。

当然`ObservableValue`类也代理了get和set操作。

```js
constructor(
        value: T,
        public enhancer: IEnhancer<T>,
        public name = "ObservableValue@" + getNextId(),
        notifySpy = true,
        private equals: IEqualsComparer<any> = comparer.default
    ) {
        super(name)
        this.value = enhancer(value, undefined, name)
    }
```



##### computedValue 

先看看使用示例：

```js
class OrderLine {
    @observable price = 0;
    @observable amount = 1;

    constructor(price) {
        this.price = price;
    }

    @computed get total() {
        return this.price * this.amount;
    }
}
```

另外，`observable.object` 和 `extendObservable` 都会自动将 getter 属性推导成计算属性，所以下面这样就足够了:

```javascript
const orderLine = observable.object({
    price: 0,
    amount: 1,
    get total() {
        return this.price * this.amount
    }
})
```

首先看一下`computed`方法：

```js
const computed: IComputed = function computed(arg1, arg2, arg3) {
    if (typeof arg2 === "string") {
        // @computed
        return computedDecorator.apply(null, arguments)
    }
    if (arg1 !== null && typeof arg1 === "object" && arguments.length === 1) {
        // @computed({ options })
        return computedDecorator.apply(null, arguments)
    }

    // computed(expr, options?)
    const opts: IComputedValueOptions<any> = typeof arg2 === "object" ? arg2 : {}
    opts.get = arg1
    opts.set = typeof arg2 === "function" ? arg2 : opts.set
    opts.name = opts.name || arg1.name || "" /* for generated name */

    return new ComputedValue(opts)
}
```

分为三个分支，作为装饰器且不带参数时，执行`computedDecorator`并返回，带参数时也是执行`computedDecorator`后返回；当`computed`用作`computed(expr, options?)`时，返回`new ComputedValue(opts)`。

很明了，先看一下`computedDecorator`做了啥。

其实就调用了`createPropDecorator`函数，第二个参数传入了一个回调函数，回调函数中有我们熟悉的`asObservableObject`，作用是返回`adm`对象，并将`adm`挂在`instance`的`$mobx`属性上，接着调用`addComputedProp`添加`instance`的计算属性。

```js
const computedDecorator = createPropDecorator(
    false,
    (
        instance: any,
        propertyName: PropertyKey,
        descriptor: any,
        decoratorTarget: any,
        decoratorArgs: any[]
    ) => {
        const { get, set } = descriptor 
        const options = decoratorArgs[0] || {}
        asObservableObject(instance).addComputedProp(instance, propertyName, {
            get,
            set,
            context: instance,
            ...options
        })
    }
)
```

`addComputedProp`将`computed`装饰的计算属性放入`this.values`中，值为`ComputedValue`类型，`options`中`get`属性在`ComputedValue`中赋值给了`this.derivation`，当计算属性依赖的`observable`变化时，计算属性的值也会重新计算。

最后用`defineProperty`重新定义目标类`target`的计算属性，做一些get、set劫持代理。

前面讲过`this.value`会在`adm`中使用。

`generateComputedPropConfig`重新定义了属性描述符的set、get函数，其实还是调用`adm`的`read`、`write`函数。

```js
addComputedProp(
        propertyOwner: any, 
        propName: PropertyKey,
        options: IComputedValueOptions<any>
    ) {
        const { target } = this
        options.name = options.name || `${this.name}.${stringifyKey(propName)}`
        this.values.set(propName, new ComputedValue(options))
        if (propertyOwner === target || isPropertyConfigurable(propertyOwner, propName))
            Object.defineProperty(propertyOwner, propName, generateComputedPropConfig(propName))
    }
```

`createPropDecorator`返回装饰器工厂函数，这个工厂函数执行时返回属性描述符（@computed无参）或一个装饰器函数（@computed({options})有参）。

```js
function createPropDecorator(
    propertyInitiallyEnumerable: boolean,
    propertyCreator: PropertyCreator
) {
    return function decoratorFactory() {
        let decoratorArguments: any[]

        const decorator = function decorate(
            target: DecoratorTarget,
            prop: string,
            descriptor: BabelDescriptor | undefined,
            applyImmediately?: any
        ) {
            if (applyImmediately === true) {
                propertyCreator(target, prop, descriptor, target, decoratorArguments)
                return null
            }
            
            if (!Object.prototype.hasOwnProperty.call(target, mobxPendingDecorators)) {
                const inheritedDecorators = target[mobxPendingDecorators]
                addHiddenProp(target, mobxPendingDecorators, { ...inheritedDecorators })
            }
            /**
             * createPropDecorator 传进来的第二个参数，
             * 然后放进了 target[mobxPendingDecorators]![prop] 属性中，
             * 供 initializeInstance 使用
             */
            target[mobxPendingDecorators]![prop] = {
                prop,
                propertyCreator,
                descriptor,
                decoratorTarget: target,
                decoratorArguments
            }
            return createPropertyInitializerDescriptor(prop, propertyInitiallyEnumerable)
        }

        if (quacksLikeADecorator(arguments)) {
            // @decorator 无参数
            decoratorArguments = EMPTY_ARRAY
            // 无参时，返回描述符descriptor（decorator.apply(null, arguments)执行返回描述符）
            return decorator.apply(null, arguments as any)
        } else {
            // @decorator(args) 有参数
            // decoratorArguments在此处赋值，在 decorator 函数中使用（利用闭包）
            decoratorArguments = Array.prototype.slice.call(arguments)
            return decorator
        }
    }
}
```

`createPropertyInitializerDescriptor`缓存了mobx store中定义的属性或方法的描述符，如果没有缓存过则重新生成新的描述符并缓存，新的描述符中`get`、`set`做拦截处理，调用了`initializeInstance`，这个函数只会执行一次，作用是将`target`上的所有属性

```js
function createPropertyInitializerDescriptor(
    prop: string,
    enumerable: boolean
): PropertyDescriptor {
    const cache = enumerable ? enumerableDescriptorCache : nonEnumerableDescriptorCache
    return (
        cache[prop] ||
        (cache[prop] = {
            configurable: true,
            enumerable: enumerable,
            get() {
                initializeInstance(this)
                return this[prop]
            },
            set(value) {
                initializeInstance(this)
                this[prop] = value
            }
        })
    )
}
```

`target[mobxPendingDecorators]`是mobx store中所有用`@observable`和`@computed`装饰的属性，即可观察对象和计算属性。这里只讲计算属性，在`initializeInstance`中将这些属性执行一遍`propertyCreator`，即`asObservableObject(instance).addComputedProp(instance, propertyName, {get,set, context: instance,...options})`目的是将属性变为计算值(`computedValue`)，并劫持其set、get操作。

```js
function initializeInstance(target: DecoratorTarget) {
    if (target[mobxDidRunLazyInitializersSymbol] === true) return
    
    const decorators = target[mobxPendingDecorators]
    if (decorators) {
        addHiddenProp(target, mobxDidRunLazyInitializersSymbol, true)
        // Build property key array from both strings and symbols
        const keys = [...Object.getOwnPropertySymbols(decorators), ...Object.keys(decorators)]
        for (const key of keys) {
            const d = decorators[key as any]
            d.propertyCreator(target, d.prop, d.descriptor, d.decoratorTarget, d.decoratorArguments)
        }
    }
}
```



接下来我们看`ComputedValue`，`ComputedValue` 同时实现了 `IDerivation` 和` IObservable` 接口，既是观察者又是被观察者，所以它的成员变量是可观察变量和衍生的集合。

先看`get`函数，初始化时走第第一个 if 分支`this.computeValue(false)`传入`false`，那么调用的是`this.derivation.call(this.scope)`，上面讲到过，`this.derivation`就是`@computed`修饰的`get`属性函数，执行这个函数，返回执行后的结果赋值给`this.value`；

第二个分支：首先会`reportObserved(this)`上报自己被观察，把自己放在`derivation`的`newObserving`队列中；接着调用`this.trackAndCompute()`，顾名思义：收集依赖和计算值，收集依赖时调用`this.computeValue(true)`，最终调用的是`trackDerivedFunction(this, this.derivation, this.scope)`，这个函数就很熟悉了吧；如果计算值发生了改变，则调用`propagateChangeConfirmed(observable: IObservable) `，将观察者的依赖状态置为`stale`（`d.dependenciesState = IDerivationState.STALE`）。

```js
public get(): T {
        if (this.isComputing) fail(`Cycle detected in computation ${this.name}: ${this.derivation}`)
        // 初始化获取绑定计算属性的依赖关系，或者在 action 中直接获取计算属性
        if (globalState.inBatch === 0 && this.observers.size === 0 && !this.keepAlive) {
            if (shouldCompute(this)) {
                this.warnAboutUntrackedRead()
                startBatch() 
                this.value = this.computeValue(false)
                endBatch()
            }
        } else {
            // reaction.runReaction 处理逻辑中，将进入第二个条件分支
            // ComputedValue 不仅会把自己 reportObserved 给 reaction
            reportObserved(this)
            // 同时自己也是 IDerivation 的派生类，通过 trackAndCompute（里面会调用 trackDerivedFunction）来取值
            // 如果 trackAndCompute 返回 true，即值改变了，向监听自己的 observers 上报 change
            if (shouldCompute(this)) if (this.trackAndCompute()) propagateChangeConfirmed(this)
        }
        const result = this.value!

        if (isCaughtException(result)) throw result.cause
        return result
    }

```

```js
computeValue(track: boolean) {
        this.isComputing = true
        globalState.computationDepth++
        let res: T | CaughtException
        if (track) {
            res = trackDerivedFunction(this, this.derivation, this.scope)
        } else {
            if (globalState.disableErrorBoundaries === true) {
                res = this.derivation.call(this.scope)
            } else {
                try {
                    res = this.derivation.call(this.scope)
                } catch (e) {
                    res = new CaughtException(e)
                }
            }
        }
        globalState.computationDepth--
        this.isComputing = false
        return res
    }
```

关于计算值，有一个细节：当`computedValue`作为`derivation`,它依赖的`observable`有变更时调用的是`propagateMaybeChanged`，这个方法是在`computedValue`的`onBecomeStale() {propagateMaybeChanged(this)}`使用。

> 调用链路：value changed --> d.onBecomeStale() --> propagateMaybeChanged

先将自己的`lowestObserverState`状态变为`POSSIBLY_STALE`，代表计算值可能会有变更，这个状态只有计算值有，因为计算值的特殊性既是观察者又是被观察者，依赖的对象有变化自己需要感知，同时自己的值一旦有变化，也要通知依赖自己的`observers`，所以这里需要有一个中间状态`可能不稳定`，只有计算值真正改变了才会让`observers`执行动作，是一个很大的性能优化。然后将自己依赖的观察者的状态`dependenciesState`变为`POSSIBLY_STALE`，表示观察者们可能需要重新执行自己的逻辑；那什么时候会将`POSSIBLY_STALE`变为`STALE`呢，需要看`propagateChangeConfirmed`方法了。

```js
function propagateMaybeChanged(observable: IObservable) {
    if (observable.lowestObserverState !== IDerivationState.UP_TO_DATE) return
    observable.lowestObserverState = IDerivationState.POSSIBLY_STALE

    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.UP_TO_DATE) {
            d.dependenciesState = IDerivationState.POSSIBLY_STALE
            if (d.isTracing !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale()
        }
    })
}
```
当一个`derivation`依赖了此`computedValue`，并且执行`runReaction`触发`get`操作时，会走到`propagateChangeConfirmed`中（计算值确实有变更），将状态`POSSIBLY_STALE`变为`STALE`。

```js
// ComputedValue 值改变重新计算时调用
function propagateChangeConfirmed(observable: IObservable) {
    if (observable.lowestObserverState === IDerivationState.STALE) return
    observable.lowestObserverState = IDerivationState.STALE

    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.POSSIBLY_STALE)
            d.dependenciesState = IDerivationState.STALE
        else if (
            // 正在依赖收集阶段
            d.dependenciesState === IDerivationState.UP_TO_DATE
        )
            observable.lowestObserverState = IDerivationState.UP_TO_DATE
    })
}
```

注：引用一段源码中关于`computedValue`实现的注释：

>  Implementation description:
>
> 1. First time it's being accessed it will compute and remember result
>
> ​       give back remembered result until 2. happens
>
> 2. First time any deep dependency change, propagate POSSIBLY_STALE to all observers, wait for 3.
>
> 3. When it's being accessed, recompute if any shallow dependency changed.
>
> ​       if result changed: propagate STALE to all observers, that were POSSIBLY_STALE from the last step.
>
> ​       go to step 2. either way

有了以上基础，就可以自己去看源码啦，在比较难的或细节的地方，可以写一个`demo`打开浏览器调试源码，总会有一种豁然开朗的感觉。

欢迎 [**star**](https://github.com/dxmz/Mobx-Chinese-Interpretation) 我的源码解读系列之`mobx`，再次感谢！



## 参考文章

### `lawler61` 

- [mobx 源码解读（一）：从零到 observable 一个 object 如何](https://zhuanlan.zhihu.com/p/85720939)
- [mobx 源码解读（二）：都 observe object 了，其他类型还会远吗](https://zhuanlan.zhihu.com/p/92053475)
- [mobx 源码解读（三）：mobx 中的依赖收集：订阅-发布模式](https://zhuanlan.zhihu.com/p/94525644)
- [mobx 源码解读（四）：讲讲 autorun 和 reaction](https://zhuanlan.zhihu.com/p/95987345)
- [mobx 源码解读（五）：如虎添翼的 mobx-react](https://zhuanlan.zhihu.com/p/97270433)

### `修范`

- [mobx源码分析（一） 构造响应式数据](https://zhuanlan.zhihu.com/p/42150181)
- [mobx源码分析（二） 订阅响应式数据](https://zhuanlan.zhihu.com/p/42225597)